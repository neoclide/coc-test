import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import {
  build as esbuild,
  type OnResolveArgs,
  type OnResolveResult,
  type Plugin,
  type PluginBuild,
  type ResolveResult,
} from 'esbuild'
import { MODULE_REGISTRY_KEY, MODULE_SPECIFIER_PREFIX } from './project-modules.js'
import type { ExtensionTarget } from './types.js'

export interface BundleOptions {
  projectRoot: string
  projectMain: string
  cocEntry: string
  /** Configured `coc-test.entryFile`; when set the extension is loaded from its bundled output. */
  entryFile?: string
  /** Directory containing `entryFile`; project modules under it are exposed to test imports. */
  entryRoot?: string
}

export interface TestBundle {
  sourceFile: string
  virtualFile: string
  code: string
  watchFiles: string[]
}

export interface ExtensionModuleBuild {
  entryFile: string
  entryRoot: string
  target: ExtensionTarget
  /** Bundled extension code, shared by every concurrent test child. */
  code: string
  watchFiles: string[]
}

export interface BuildExtensionModulesOptions {
  projectRoot: string
  entryFile: string
  externals?: string[]
  target?: ExtensionTarget
}

const RUNTIME_NAMESPACE = 'coc-test-runtime'
const VIRTUAL_COC = 'coc-exports'
const VIRTUAL_EXTENSION = 'extension-exports'

export async function bundleTests(
  files: string[],
  options: BundleOptions,
): Promise<TestBundle[]> {
  const bundles: TestBundle[] = []

  for (const [index, file] of files.entries()) {
    bundles.push(await bundleOne(file, index, options))
  }

  return bundles
}

async function bundleOne(
  file: string,
  index: number,
  options: BundleOptions,
): Promise<TestBundle> {
  const virtualFile = virtualFilename(file, index, options.projectRoot)

  try {
    const result = await esbuild({
      entryPoints: [file],
      absWorkingDir: options.projectRoot,
      absPaths: ['metafile'],
      mainFields: ['module', 'main'],
      bundle: true,
      format: 'cjs',
      logLevel: 'silent',
      metafile: true,
      outfile: virtualFile,
      platform: 'node',
      plugins: [runtimeModulePlugin(options)],
      preserveSymlinks: true,
      sourcemap: 'inline',
      treeShaking: false,
      write: false,
    })
    if (result.outputFiles.length !== 1) {
      throw new Error(
        `Expected one output file for ${file}, received ${result.outputFiles.length}.`,
      )
    }

    return {
      sourceFile: file,
      virtualFile,
      code: normalizeInlineSourceMap(result.outputFiles[0].text, virtualFile),
      watchFiles: watchFilesFromMetafile(result.metafile),
    }
  } catch (error) {
    throw new Error(
      `Failed to bundle test ${file}: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

/** Resolve the extension's local dependency graph without writing an output file. */
export async function collectExtensionWatchFiles(options: BundleOptions): Promise<string[]> {
  return collectInternalModules(options.projectRoot, options.projectMain)
}

async function collectInternalModules(projectRoot: string, entryFile: string): Promise<string[]> {
  const result = await esbuild({
    entryPoints: [entryFile],
    absWorkingDir: projectRoot,
    absPaths: ['metafile'],
    bundle: true,
    format: 'cjs',
    logLevel: 'silent',
    metafile: true,
    platform: 'node',
    plugins: [extensionGraphPlugin(projectRoot)],
    preserveSymlinks: true,
    treeShaking: false,
    write: false,
  })
  return watchFilesFromMetafile(result.metafile)
}

/**
 * Bundle the extension for testing.
 *
 * The project root (the directory containing `package.json`) is the extension
 * root; the directory containing `entryFile` is the bundling root, and every
 * `ts`, `js`, `mjs` and `cjs` file below it is scanned and a manifest module is
 * generated that imports each one and registers its exports in the shared
 * `__coc_test_modules__` registry. The manifest is concatenated with the
 * `entryFile` source and bundled by esbuild into one CommonJS file by default,
 * or an ESM file when configured, so
 * the extension and the registry reference the same module instances. External
 * dependencies are bundled unless listed in `externals`. No files are written:
 * the bundle code is passed to
 * coc.nvim through the loader's `sourceCode` option and the project's own
 * package.json provides the extension metadata.
 */
export async function buildExtensionModules(options: BuildExtensionModulesOptions): Promise<ExtensionModuleBuild> {
  const projectRoot = normalize(options.projectRoot)
  const entryFile = normalize(options.entryFile)
  const entryRoot = path.dirname(entryFile)
  const target = options.target ?? 'commonjs'
  const externals = options.externals ?? []
  const scannedFiles = scanModuleFiles(entryRoot)
  if (!scannedFiles.includes(entryFile)) {
    throw new Error(`coc-test entryFile is not a module file: ${options.entryFile}`)
  }

  const entrySource = fs.readFileSync(path.resolve(entryFile), 'utf8')
  const source = `${entrySource}\n${generateModuleManifest(entryFile, scannedFiles)}`
  const build = await esbuild({
    entryPoints: [entryFile],
    absWorkingDir: path.resolve(projectRoot),
    bundle: true,
    format: target === 'esm' ? 'esm' : 'cjs',
    external: externals,
    logLevel: 'silent',
    platform: 'node',
    preserveSymlinks: true,
    treeShaking: false,
    write: false,
    plugins: [extensionEntryPlugin(entryFile, source), extensionBundlePlugin(externals)],
  })
  if (build.errors.length > 0) {
    throw new Error(`Failed to build extension modules: ${build.errors.map(error => error.text).join('\n')}`)
  }
  if (build.outputFiles.length !== 1) {
    throw new Error(`Expected one extension bundle, received ${build.outputFiles.length}.`)
  }
  const code = build.outputFiles[0].text

  return {
    entryFile,
    entryRoot,
    target,
    code,
    watchFiles: [...scannedFiles].sort(),
  }
}

function extensionGraphPlugin(projectRoot: string): Plugin {
  const root = normalize(projectRoot)
  const builtins = builtinModuleSet()
  return {
    name: 'coc-test-extension-watch-files',
    setup(build) {
      const skipSelf = {}
      build.onResolve({ filter: /.*/, namespace: 'file' }, async args => {
        if (args.kind === 'entry-point' || args.pluginData === skipSelf) return
        if (args.path === 'coc.nvim' || builtins.has(args.path)) {
          return { path: args.path, external: true }
        }

        const resolved = await resolveImport(build, args, skipSelf)
        if (!resolved) return unresolvedExternal(args)
        if (resolved.external || resolved.namespace !== 'file') return forwardResolution(resolved)

        const id = normalize(stripQuery(resolved.path))
        if (!isInside(id, root) || id.includes('/node_modules/')) {
          return externalResolution(resolved)
        }
        return forwardResolution(resolved)
      })
    },
  }
}

/**
 * Serve the concatenated entry source (entry file plus generated module
 * manifest) for the configured entry file, keeping the entry's directory as
 * the base for its relative imports.
 */
function extensionEntryPlugin(entryFile: string, source: string): Plugin {
  const loader = loaderForFile(entryFile)
  const resolveDir = path.dirname(path.resolve(entryFile))
  const pathVariants = new Set<string>([normalize(entryFile)])
  try {
    pathVariants.add(normalize(fs.realpathSync(entryFile)))
  } catch {
    // Keep the resolved path when realpath fails.
  }
  const filter = new RegExp(`^(${[...pathVariants].map(escapeRegExp).join('|')})$`)
  return {
    name: 'coc-test-extension-entry',
    setup(build) {
      build.onLoad({ filter, namespace: 'file' }, () => ({
        contents: source,
        loader,
        resolveDir,
      }))
    },
  }
}

/**
 * Bundle local modules and package dependencies by default. Configured
 * externals retain their original specifier. `coc.nvim` is mapped to the shared
 * `__coc_test_coc_exports__` global, so the bundle does not depend on the
 * extension sandbox's require interception.
 */
function extensionBundlePlugin(externals: readonly string[]): Plugin {
  const builtins = builtinModuleSet()
  return {
    name: 'coc-test-extension-bundle',
    setup(build) {
      const skipSelf = {}
      build.onResolve({ filter: /.*/, namespace: 'file' }, async args => {
        if (args.kind === 'entry-point' || args.pluginData === skipSelf) return
        if (args.path === 'coc.nvim') {
          return { path: VIRTUAL_COC, namespace: RUNTIME_NAMESPACE }
        }
        if (isExternalSpecifier(args.path, externals)) {
          return { path: args.path, external: true }
        }
        if (builtins.has(args.path)) {
          return { path: args.path, external: true }
        }

        const resolved = await resolveImport(build, args, skipSelf)
        if (!resolved) return { path: args.path, external: true }
        if (resolved.external || resolved.namespace !== 'file') return forwardResolution(resolved)

        return forwardResolution(resolved)
      })

      build.onLoad({ filter: /.*/, namespace: RUNTIME_NAMESPACE }, args => ({
        contents: runtimeCommonJsModule('__coc_test_coc_exports__', 'coc.nvim'),
        loader: 'js',
      }))
    },
  }
}

function isExternalSpecifier(specifier: string, externals: readonly string[]): boolean {
  return externals.some(external => specifier === external || specifier.startsWith(`${external}/`))
}

function scanModuleFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.coc-test-virtual') continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && isModuleSource(full)) {
        files.push(normalize(full))
      }
    }
  }
  walk(root)
  return files
}

/**
 * Generate ESM code that imports every scanned module (except the entry, which
 * is the bundle's own module) and registers its exports in the shared registry.
 */
function generateModuleManifest(entryFile: string, scannedFiles: string[]): string {
  const lines: string[] = []
  let index = 0
  for (const file of scannedFiles) {
    if (file === entryFile) continue
    lines.push(`import * as __coc_test_module_${index} from ${JSON.stringify(file)}`)
    lines.push(`globalThis[${JSON.stringify(MODULE_REGISTRY_KEY)}][${JSON.stringify(file)}] = __coc_test_module_${index}`)
    index++
  }
  if (lines.length === 0) return ''
  return `\n// Generated by coc-test: expose extension modules to test imports\n${lines.join('\n')}\n`
}

function isModuleSource(file: string): boolean {
  return /\.(?:[cm]?[jt]s)$/.test(file)
}

function loaderForFile(file: string): 'ts' | 'tsx' | 'js' {
  if (/\.tsx$/.test(file)) return 'tsx'
  if (/\.(?:ts|mts|cts)$/.test(file)) return 'ts'
  return 'js'
}

function toPosix(value: string): string {
  return value.replaceAll(path.sep, '/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface InlineSourceMap {
  sourceRoot?: string
  sources?: string[]
  [key: string]: unknown
}

/** Make source paths independent of the virtual bundle's filesystem location. */
function normalizeInlineSourceMap(code: string, sourceFile: string): string {
  const pattern = /(\/\/# sourceMappingURL=data:application\/json[^,]*,)([A-Za-z0-9+/=]+)(\s*)$/
  const match = pattern.exec(code)
  if (!match) return code

  const sourceMap = JSON.parse(Buffer.from(match[2], 'base64').toString('utf8')) as InlineSourceMap
  if (!Array.isArray(sourceMap.sources)) return code

  const sourceRoot = sourceMap.sourceRoot
  const baseDirectory = sourceRoot && !hasUrlScheme(sourceRoot)
    ? path.resolve(path.dirname(sourceFile), sourceRoot)
    : path.dirname(sourceFile)
  sourceMap.sources = sourceMap.sources.map(source => {
    if (path.isAbsolute(source) || hasUrlScheme(source) || source.startsWith('\0')) return source
    return path.resolve(baseDirectory, source)
  })
  if (sourceRoot && !hasUrlScheme(sourceRoot)) delete sourceMap.sourceRoot

  const encoded = Buffer.from(JSON.stringify(sourceMap)).toString('base64')
  return `${code.slice(0, match.index)}${match[1]}${encoded}${match[3]}`
}

function hasUrlScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
}

/**
 * Rewrites static imports/requires for coc.nvim and the extension main entry to
 * virtual CommonJS modules. Those modules read already-created values from
 * globalThis, preserving object identity without patching Module._load.
 */
function runtimeModulePlugin(options: BundleOptions): Plugin {
  const projectRoot = normalize(options.projectRoot)
  const projectMain = normalize(options.projectMain)
  const cocEntry = normalize(options.cocEntry)
  const entryFile = options.entryFile ? normalize(options.entryFile) : undefined
  const entryRoot = options.entryRoot ? normalize(options.entryRoot) : undefined
  const builtins = builtinModuleSet()

  return {
    name: 'coc-test-runtime-modules',
    setup(build) {
      const skipSelf = {}
      build.onResolve({ filter: /.*/, namespace: 'file' }, async args => {
        if (args.kind === 'entry-point' || args.pluginData === skipSelf) return
        if (args.path === 'coc.nvim') {
          return { path: VIRTUAL_COC, namespace: RUNTIME_NAMESPACE }
        }
        if (builtins.has(args.path)) return { path: args.path, external: true }

        const resolved = await resolveImport(build, args, skipSelf)
        if (!resolved) return unresolvedExternal(args)
        if (resolved.external || resolved.namespace !== 'file') return forwardResolution(resolved)

        const resolvedId = normalize(stripQuery(resolved.path))
        if (entryRoot && isInside(resolvedId, entryRoot)) {
          if (resolvedId === entryFile) {
            return { path: VIRTUAL_EXTENSION, namespace: RUNTIME_NAMESPACE }
          }
          // Bundle a runtime shim instead of leaving a custom specifier for
          // CommonJS `require()`. Node.js 22.15/22.16 module hooks do not
          // intercept a require issued by a CommonJS module loaded through a
          // hook. The shim reads the extension bundle's registry at runtime,
          // so it still exposes the exact same module instance.
          const relative = toPosix(path.relative(path.resolve(projectRoot), path.resolve(resolvedId)))
          return { path: `${MODULE_SPECIFIER_PREFIX}${relative}`, namespace: RUNTIME_NAMESPACE }
        }
        if (resolvedId === projectMain) {
          return { path: VIRTUAL_EXTENSION, namespace: RUNTIME_NAMESPACE }
        }
        if (resolvedId === cocEntry) {
          return { path: VIRTUAL_COC, namespace: RUNTIME_NAMESPACE }
        }
        if (isInside(resolvedId, projectRoot)) return forwardResolution(resolved)

        return externalResolution(resolved)
      })

      build.onLoad({ filter: /.*/, namespace: RUNTIME_NAMESPACE }, args => ({
        contents: args.path === VIRTUAL_COC
          ? runtimeCommonJsModule('__coc_test_coc_exports__', 'coc.nvim')
          : args.path === VIRTUAL_EXTENSION
            ? runtimeCommonJsModule('__coc_test_extension_exports__', 'extension exports')
            : runtimeProjectModule(projectRoot, args.path),
        loader: 'js',
      }))
    },
  }
}

async function resolveImport(
  build: PluginBuild,
  args: OnResolveArgs,
  skipSelf: object,
): Promise<ResolveResult | undefined> {
  const resolved = await build.resolve(args.path, {
    importer: args.importer,
    namespace: args.namespace,
    resolveDir: args.resolveDir,
    kind: args.kind,
    pluginData: skipSelf,
    with: args.with,
  })
  return resolved.errors.length === 0 ? resolved : undefined
}

function forwardResolution(resolved: ResolveResult): OnResolveResult {
  return {
    path: resolved.path,
    namespace: resolved.namespace,
    suffix: resolved.suffix,
    external: resolved.external,
    sideEffects: resolved.sideEffects,
    warnings: resolved.warnings,
  }
}

function externalResolution(resolved: ResolveResult): OnResolveResult {
  return {
    path: resolved.path,
    suffix: resolved.suffix,
    external: true,
    warnings: resolved.warnings,
  }
}

function unresolvedExternal(args: OnResolveArgs): OnResolveResult {
  return { path: args.path, external: true }
}

function builtinModuleSet(): Set<string> {
  return new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])
}

function watchFilesFromMetafile(metafile: { inputs: Record<string, unknown> }): string[] {
  return Object.keys(metafile.inputs)
    .filter(filename => path.isAbsolute(filename))
    .map(normalizeFilesystemPath)
}

function runtimeCommonJsModule(globalKey: string, label: string): string {
  return `
const value = globalThis[${JSON.stringify(globalKey)}]
if (value === undefined) {
  throw new Error(${JSON.stringify(`coc-test runtime value is unavailable: ${label}`)})
}
module.exports = value
`
}

function runtimeProjectModule(projectRoot: string, specifier: string): string {
  const file = normalize(path.resolve(projectRoot, specifier.slice(MODULE_SPECIFIER_PREFIX.length)))
  return `
const registry = globalThis[${JSON.stringify(MODULE_REGISTRY_KEY)}]
if (registry === undefined) {
  throw new Error(${JSON.stringify(`coc-test module registry is unavailable for ${file}`)})
}
const value = registry[${JSON.stringify(file)}]
if (value === undefined) {
  throw new Error(${JSON.stringify(`coc-test module is not part of the extension bundle: ${file}`)})
}
module.exports = value
`
}

function virtualFilename(
  source: string,
  index: number,
  projectRoot: string,
): string {
  const relative = path.relative(projectRoot, source)
  const parsed = path.parse(relative)
  const safeDirectory = parsed.dir
    .split(path.sep)
    .filter(part => part && part !== '..')
    .join(path.sep)

  return path.join(
    projectRoot,
    '.coc-test-virtual',
    safeDirectory,
    `${String(index).padStart(4, '0')}-${parsed.name}.test.cjs`,
  )
}

function stripQuery(value: string): string {
  return value.replace(/[?#].*$/, '')
}

function normalize(value: string): string {
  return path.resolve(value).replaceAll('\\', '/')
}

function normalizeFilesystemPath(value: string): string {
  return path.resolve(stripQuery(value))
}

function isInside(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}/`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
