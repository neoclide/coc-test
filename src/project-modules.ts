import * as module from 'node:module'
/**
 * Internal esbuild namespace for runtime shims that read project modules from
 * the extension bundle's registry.
 */
export const MODULE_SPECIFIER_PREFIX = 'coc-test-module:'

/** Global registry populated by the bundled extension and read by test shims. */
export const MODULE_REGISTRY_KEY = '__coc_test_modules__'

export const MODULE_HOOKS_REQUIRED_MESSAGE =
  'coc-test requires Node.js module.registerHooks support (Node.js 22.15.0 or newer).'

type Registry = Record<string, unknown>

interface RegistryGlobal {
  [MODULE_REGISTRY_KEY]?: Registry
  __coc_test_extension_exports__?: unknown
}

/**
 * `module.registerHooks()` was added in Node.js 22.15.0. Use a namespace
 * import so older Node.js versions can reach this diagnostic instead of
 * failing while evaluating a named import from `node:module`.
 */
export function assertModuleHooksAvailable(registerHooks: unknown = module.registerHooks): void {
  if (typeof registerHooks !== 'function') throw new Error(MODULE_HOOKS_REQUIRED_MESSAGE)
}

export function registerModuleHooks(
  options: Parameters<typeof module.registerHooks>[0],
): ReturnType<typeof module.registerHooks> {
  assertModuleHooksAvailable()
  return module.registerHooks(options)
}

/** Create the shared module registry before the extension bundle is loaded. */
export function createModuleRegistry(): void {
  ;(globalThis as RegistryGlobal)[MODULE_REGISTRY_KEY] = {}
}

export function removeModuleRegistry(): void {
  delete (globalThis as RegistryGlobal)[MODULE_REGISTRY_KEY]
}
