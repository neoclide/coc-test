import { strToU8 } from 'fflate'
import { state } from './state.js'

export const childPid = process.pid
export const esmDependencyValue = strToU8('esm').length
export const setupCompleted = globalThis.__coc_test_fixture_setup__ === true
export const getState = (): typeof state => state

export async function activate(): Promise<{ activated: boolean }> {
  return { activated: true }
}
