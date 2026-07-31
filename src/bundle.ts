import { builtinModules } from 'node:module'
import path from 'node:path'
import { rolldown, type Plugin } from 'rolldown'

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

const VIRTUAL_COC = '\0coc-test:runtime-coc-exports'
const VIRTUAL_EXTENSION = '\0coc-test:runtime-extension-exports'

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
  const bundle = await rolldown({
    input: file,
    platform: 'node',
    plugins: [runtimeModulePlugin(options)],
    treeshake: false,
  })

  try {
    const result = await bundle.generate({
      format: 'cjs',
      sourcemap: 'inline',
      exports: 'auto',
    })
    const chunks = result.output.filter(item => item.type === 'chunk')
    if (chunks.length !== 1) {
      throw new Error(
        `Expected one output chunk for ${file}, received ${chunks.length}.`,
      )
    }

    const watchFiles = await bundle.watchFiles
    return {
      sourceFile: file,
      virtualFile: virtualFilename(file, index, options.projectRoot),
      code: normalizeInlineSourceMap(chunks[0].code, file),
      watchFiles: watchFiles.map(normalizeFilesystemPath),
    }
  } catch (error) {
    throw new Error(
      `Failed to bundle test ${file}: ${errorMessage(error)}`,
      { cause: error },
    )
  } finally {
    await bundle.close()
  }
}

/** Resolve the extension's local dependency graph without writing an output file. */
export async function collectExtensionWatchFiles(options: BundleOptions): Promise<string[]> {
  const bundle = await rolldown({
    input: options.projectMain,
    platform: 'node',
    plugins: [extensionGraphPlugin(options.projectRoot)],
    treeshake: false,
  })
  try {
    await bundle.generate({ format: 'cjs' })
    return (await bundle.watchFiles).map(normalizeFilesystemPath)
  } finally {
    await bundle.close()
  }
}

function extensionGraphPlugin(projectRoot: string): Plugin {
  const root = normalize(projectRoot)
  const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])
  return {
    name: 'coc-test-extension-watch-files',
    async resolveId(source, importer) {
      if (source === 'coc.nvim' || builtins.has(source)) return { id: source, external: true }
      if (!importer) return null
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      if (!resolved || resolved.external || resolved.id.startsWith('\0')) return resolved
      const id = normalize(stripQuery(resolved.id))
      if (!isInside(id, root) || id.includes('/node_modules/')) {
        return { id: resolved.id, external: true }
      }
      return resolved
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
  const builtins = new Set([
    ...builtinModules,
    ...builtinModules.map(name => `node:${name}`),
  ])

  return {
    name: 'coc-test-runtime-modules',

    async resolveId(source, importer) {
      if (source === VIRTUAL_COC || source === VIRTUAL_EXTENSION) return source
      if (source === 'coc.nvim') return VIRTUAL_COC
      if (builtins.has(source)) return { id: source, external: true }
      if (!importer || importer.startsWith('\0')) return null

      const resolved = await this.resolve(source, importer, { skipSelf: true })

      if (!resolved) return { id: source, external: true }
      if (resolved.external) return resolved
      if (resolved.id.startsWith('\0')) return resolved

      const resolvedId = normalize(stripQuery(resolved.id))
      if (resolvedId === projectMain) return VIRTUAL_EXTENSION
      if (resolvedId === cocEntry) return VIRTUAL_COC
      if (isInside(resolvedId, projectRoot)) return resolved

      return { id: resolved.id, external: true }
    },

    load(id) {
      if (id === VIRTUAL_COC) {
        return {
          code: runtimeCommonJsModule(
            '__coc_test_coc_exports__',
            'coc.nvim',
          ),
          moduleType: 'js',
        }
      }

      if (id === VIRTUAL_EXTENSION) {
        return {
          code: runtimeCommonJsModule(
            '__coc_test_extension_exports__',
            'extension exports',
          ),
          moduleType: 'js',
        }
      }

      return null
    },
  }
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
