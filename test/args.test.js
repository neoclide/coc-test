import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs } from '../lib/args.js'

test('parses a local coc.nvim path and Neovim', () => {
  const parsed = parseArgs(['--coc-path', '/opt/coc.nvim', '--nvim', 'test/*.test.js'])
  assert.equal(parsed.action, 'run')
  assert.equal(parsed.options.cocPath, '/opt/coc.nvim')
  assert.equal(parsed.options.editor, 'nvim')
  assert.deepEqual(parsed.options.files, ['test/*.test.js'])
})

test('parses Vim selection', () => {
  const parsed = parseArgs(['--vim', '--watch', 'test/example.test.js'])
  assert.equal(parsed.options.editor, 'vim')
  assert.equal(parsed.options.watch, true)
})

test('parses short watch option', () => {
  const parsed = parseArgs(['-w', 'test/example.test.js'])
  assert.equal(parsed.options.watch, true)
})

test('parses standalone init action', () => {
  assert.deepEqual(parseArgs(['--init']), { action: 'init' })
  assert.throws(() => parseArgs(['--init', 'test/test.ts']), /cannot be combined/)
})

test('rejects download options with a local coc.nvim path', () => {
  assert.throws(
    () => parseArgs(['--coc-path', '/opt/coc.nvim', '--download', 'test/*.test.js']),
    /cannot be combined/,
  )
  assert.throws(
    () => parseArgs(['--coc-path', '/opt/coc.nvim', '--use', 'v0.0.83', 'test/*.test.js']),
    /cannot be combined/,
  )
})

test('rejects an invalid test name pattern', () => {
  assert.throws(
    () => parseArgs(['--test-name-pattern', '([', 'test/*.test.js']),
    /Invalid test name pattern: /,
  )
})

test('parses long options with an equals sign', () => {
  const versionParsed = parseArgs(['--use=v0.0.83', '--test-name-pattern=^foo$', 'test/*.test.js'])
  assert.equal(versionParsed.options.cocVersion, 'v0.0.83')
  assert.equal(versionParsed.options.testNamePattern, '^foo$')

  const pathParsed = parseArgs(['--coc-path=/opt/coc.nvim', 'test/*.test.js'])
  assert.equal(pathParsed.options.cocPath, '/opt/coc.nvim')
})

test('rejects a long option with a missing equals value', () => {
  assert.throws(() => parseArgs(['--use=', 'test/*.test.js']), /Missing value for --use/)
  assert.throws(() => parseArgs(['--coc-path=', 'test/*.test.js']), /Missing value for --coc-path/)
})

test('rejects an unknown long option with an equals sign', () => {
  assert.throws(() => parseArgs(['--unknown=x', 'test/*.test.js']), /Unknown option: --unknown/)
})

test('parses the force exit flag', () => {
  assert.equal(parseArgs(['--force-exit', 'test/*.test.js']).options.forceExit, true)
  assert.equal(parseArgs(['test/*.test.js']).options.forceExit, false)
})
