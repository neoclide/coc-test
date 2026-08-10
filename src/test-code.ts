export const TEARDOWN_KEY = '__coc_test_child_teardown__'

// Keep the injected hook on one line so existing bundle/source-map line offsets stay intact.
const TEARDOWN_HOOK = `;(()=>{const{after}=require('node:test');after(async()=>{const teardown=globalThis[${JSON.stringify(TEARDOWN_KEY)}];if(typeof teardown!=='function')throw new Error('coc-test child teardown callback is unavailable');await teardown()})})();`

/** Register teardown before evaluating a bundle, including when its top level fails. */
export function injectTeardownHook(source: string): string {
  return `${TEARDOWN_HOOK}${source}`
}
