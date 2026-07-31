export const COC_EXPORTS_KEY = '__coc_test_coc_exports__'
export const EXTENSION_EXPORTS_KEY = '__coc_test_extension_exports__'

type CocTestGlobal = typeof globalThis & {
  __coc_test_coc_exports__?: unknown
  __coc_test_extension_exports__?: unknown
}

function runtimeGlobal(): CocTestGlobal {
  return globalThis as CocTestGlobal
}

export function installRuntimeGlobals(options: {
  cocExports: unknown
  extensionExports: unknown
}): () => void {
  const target = runtimeGlobal()
  const previousCoc = target[COC_EXPORTS_KEY]
  const previousExtension = target[EXTENSION_EXPORTS_KEY]
  const hadCoc = Object.prototype.hasOwnProperty.call(target, COC_EXPORTS_KEY)
  const hadExtension = Object.prototype.hasOwnProperty.call(target, EXTENSION_EXPORTS_KEY)

  target[COC_EXPORTS_KEY] = options.cocExports
  target[EXTENSION_EXPORTS_KEY] = options.extensionExports

  return () => {
    if (hadCoc) target[COC_EXPORTS_KEY] = previousCoc
    else delete target[COC_EXPORTS_KEY]

    if (hadExtension) target[EXTENSION_EXPORTS_KEY] = previousExtension
    else delete target[EXTENSION_EXPORTS_KEY]
  }
}
