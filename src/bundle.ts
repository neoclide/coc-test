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

export interface BundleOptions {
  projectRoot: string
  projectMain: string
  cocEntry: string
}

export interface TestBundle {
  sourceFile: string
  virtualFile: string
  code: string
  watchFiles: string[]
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
  const result = await esbuild({
    entryPoints: [options.projectMain],
    absWorkingDir: options.projectRoot,
    absPaths: ['metafile'],
    bundle: true,
    format: 'cjs',
    logLevel: 'silent',
    metafile: true,
    platform: 'node',
    plugins: [extensionGraphPlugin(options.projectRoot)],
    preserveSymlinks: true,
    treeShaking: false,
    write: false,
  })
  return watchFilesFromMetafile(result.metafile)
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
          : runtimeCommonJsModule('__coc_test_extension_exports__', 'extension exports'),
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
