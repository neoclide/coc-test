import { pathToFileURL } from 'node:url'

/** Load a project setup module before coc.nvim loads the extension. */
export async function runSetup(filename: string | undefined): Promise<void> {
  if (!filename) return
  await import(pathToFileURL(filename).href)
}
