import { registerHooks } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Import specifier used by bundled tests to reference project modules. The
 * value after the prefix is the absolute path of the source file. The esbuild
 * runtime plugin rewrites relative project imports to this specifier, and the
 * hooks below resolve it to the same module instance the extension bundle uses.
 */
export const MODULE_SPECIFIER_PREFIX = 'coc-test-module:'

/** Global registry populated by the bundled extension and read by the module hooks. */
export const MODULE_REGISTRY_KEY = '__coc_test_modules__'

/** Specifier prefix used by the extension stub to reach the in-memory bundle. */
export const EXTENSION_BUNDLE_SPECIFIER_PREFIX = 'coc-test-extension:'

/** Virtual module path used as the bundle module's identity. */
export function extensionBundlePath(extensionRoot: string): string {
  return path.join(path.resolve(extensionRoot), 'index.bundle.js')
}

type Registry = Record<string, unknown>

interface RegistryGlobal {
  [MODULE_REGISTRY_KEY]?: Registry
  __coc_test_extension_exports__?: unknown
}

/** Create the shared module registry before the extension bundle is loaded. */
export function createModuleRegistry(): void {
  ;(globalThis as RegistryGlobal)[MODULE_REGISTRY_KEY] = {}
}

export function removeModuleRegistry(): void {
  delete (globalThis as RegistryGlobal)[MODULE_REGISTRY_KEY]
}

export interface ProjectModuleHooks {
  deregister(): void
}

/**
 * Serve project module imports and the extension bundle code.
 *
 * The extension bundle references `coc.nvim` through the shared
 * `__coc_test_coc_exports__` global, so the bundle code is independent of the
 * sandbox and can be served directly by these hooks. Test bundles reference
 * project modules through the `coc-test-module:` specifier, which is served
 * from the extension bundle's module registry.
 */
export function registerProjectModuleHooks(options: {
  projectRoot: string
  entryFile: string
  extensionRoot: string
  extensionCode: string
}): ProjectModuleHooks {
  const bundlePath = extensionBundlePath(options.extensionRoot)
  const bundleUrl = pathToFileURL(bundlePath).href
  const normalizedEntry = normalizePath(options.entryFile)
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(EXTENSION_BUNDLE_SPECIFIER_PREFIX)) {
        return { url: bundleUrl, shortCircuit: true }
      }
      if (specifier.startsWith(MODULE_SPECIFIER_PREFIX)) {
        return { url: specifier, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },

    load(url, context, nextLoad) {
      if (url === bundleUrl) {
        return {
          format: 'commonjs',
          source: options.extensionCode,
          shortCircuit: true,
        }
      }
      if (!url.startsWith(MODULE_SPECIFIER_PREFIX)) return nextLoad(url, context)
      const file = normalizePath(resolveModulePath(options.projectRoot, url.slice(MODULE_SPECIFIER_PREFIX.length)))
      if (file === normalizedEntry) {
        return runtimeCommonJsModule('__coc_test_extension_exports__', 'extension exports')
      }
      const global = globalThis as RegistryGlobal
      const registry = global[MODULE_REGISTRY_KEY]
      if (registry === undefined) {
        throw new Error(`coc-test module registry is unavailable for ${file}`)
      }
      if (registry[file] === undefined) {
        throw new Error(`coc-test module is not part of the extension bundle: ${file}`)
      }
      return {
        format: 'commonjs',
        source: `module.exports = globalThis[${JSON.stringify(MODULE_REGISTRY_KEY)}][${JSON.stringify(file)}]`,
        shortCircuit: true,
      }
    },
  })
}

function runtimeCommonJsModule(globalKey: string, label: string) {
  return {
    format: 'commonjs' as const,
    source: `
const value = globalThis[${JSON.stringify(globalKey)}]
if (value === undefined) {
  throw new Error(${JSON.stringify(`coc-test runtime value is unavailable: ${label}`)})
}
module.exports = value
`,
    shortCircuit: true,
  }
}

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll('\\', '/')
}

function resolveModulePath(projectRoot: string, value: string): string {
  const stripped = stripQuery(value)
  return path.isAbsolute(stripped) ? stripped : path.resolve(projectRoot, stripped)
}

function stripQuery(value: string): string {
  return value.replace(/[?#].*$/, '')
}
