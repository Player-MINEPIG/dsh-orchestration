/**
 * Guards the client half's contract with the harness.
 *
 * `lib/client.js` is not an ordinary module: DSH concatenates every plugin's
 * client half into ONE script (`/plugins/??a/client.js,b/client.js,…`) and the
 * boot config addresses each one by PACKAGE NAME. Two things follow, and both
 * were learned the hard way on 2026-09-22:
 *
 *   1. The `id` in `window.__ModuleLoader__.load({…})` must equal the package
 *      name. It said `dsh-jev` while the package was `dsh-jev-plugin`, the
 *      loader lookup missed, and the client half died with
 *      `failed to import loader entry` — taking the whole Settings card with it.
 *   2. Nothing may be declared at the top level. The file shares a script scope
 *      with ~40 other plugins, so a top-level `const` risks
 *      `Identifier 'X' has already been declared`, which would take down every
 *      client plugin in the bundle, not just this one.
 *
 * This is a test rather than a shared constant precisely because the shared
 * constant would itself be the top-level declaration that breaks rule 2.
 *
 * Run: node --test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BRIDGE_PREFIX, NS } from '../lib/index.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Remove block and line comments so the checks see code, not prose. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"\\])\/\/.*$/, '$1'))
    .join('\n')
}

const code = stripComments(client)

test('the module loader id equals the package name', () => {
  const match = code.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.ok(match, 'no __ModuleLoader__.load({ id: … }) found in lib/client.js')
  assert.equal(
    match[1],
    pkg.name,
    `the client registers as "${match[1]}" but the package is "${pkg.name}"; ` +
      'the boot config is keyed by package name, so the loader will not find it',
  )
})

test('every PACKAGE constant in the client agrees with package.json', () => {
  const declared = [...code.matchAll(/const PACKAGE = '([^']+)'/g)].map((m) => m[1])
  assert.ok(declared.length > 0, 'expected a scoped PACKAGE constant inside the factory')
  for (const value of declared) assert.equal(value, pkg.name)
})

test('the client declares nothing at the top level', () => {
  // The whole file must be one statement: the load call. Anything before it is
  // a top-level declaration sharing a scope with ~40 other plugins.
  const trimmed = code.trim()
  assert.match(trimmed, /^window\.__ModuleLoader__\.load\(\{/, 'lib/client.js must open with the load call')
  assert.match(trimmed, /\}\)$/, 'lib/client.js must close with the load call')
  const before = code.slice(0, code.indexOf('window.__ModuleLoader__.load({'))
  assert.equal(before.trim(), '', `unexpected top-level code before the load call: ${before.trim().slice(0, 80)}`)
})

test('the bridge path and the settings namespace match between the two halves', () => {
  // Same class of coupling as the loader id: the host registers the routes and
  // the client calls them, so these strings must be identical in both files.
  const bridge = code.match(/const BRIDGE = '([^']+)'/)
  assert.ok(bridge, 'no BRIDGE constant in lib/client.js')
  assert.equal(bridge[1], BRIDGE_PREFIX)

  const ns = code.match(/const NS = '([^']+)'/)
  assert.ok(ns, 'no NS constant in lib/client.js')
  assert.equal(ns[1], NS)
})
