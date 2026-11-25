/**
 * Contract test for the plugin-market index: the official Discover tab and the
 * `plugin_market` tool both read this document, and they reject the whole index
 * on the first violated rule. Validating it here with the official validator
 * keeps a malformed index from reaching other people's Discover tabs.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const ROOT = new URL('..', import.meta.url)
const INDEX_URL = 'https://example.invalid/plugin-index.json'

const readJson = async (name) => JSON.parse(await readFile(new URL(name, ROOT), 'utf8'))

/** The published index, validated the same way a client validates it. */
async function validatedIndex() {
  return parseMarketIndex(await readJson('plugin-index.json'), INDEX_URL)
}

test('the index is valid format 1', async () => {
  const raw = await readJson('plugin-index.json')
  assert.equal(raw.format, 1)
  // Throws a MarketIndexError carrying the JSON path on any violation.
  await validatedIndex()
})

test('the index describes exactly this package and version', async () => {
  const manifest = await readJson('package.json')
  const index = await validatedIndex()

  const entry = index.plugins.find((plugin) => plugin.name === manifest.name)
  assert.ok(entry, `the index must list ${manifest.name}`)

  const versions = entry.versions.map((version) => version.version)
  assert.deepEqual(versions, [manifest.version], 'only the current version is published')

  const [version] = entry.versions
  assert.equal(version.engines.dsh, manifest.engines.dsh, 'the index engine range mirrors the manifest')
  assert.equal(version.source.type, 'npm', 'npm is the default source')
})

test('the published install target is a plain registry spec', async () => {
  const manifest = await readJson('package.json')
  const index = await validatedIndex()
  const entry = index.plugins.find((plugin) => plugin.name === manifest.name)
  const target = marketInstallTarget(entry.name, entry.versions[0])
  assert.deepEqual(target, { spec: `${manifest.name}@${manifest.version}` })
})

test('localized display text is present in both languages', async () => {
  const index = await validatedIndex()
  const [entry] = index.plugins
  // The format requires `en`; the Chinese text is what most users here read.
  assert.ok(entry.title.en.length > 0)
  assert.ok(entry.title.zh.length > 0)
  assert.ok(entry.description.en.length > 20)
  assert.ok(entry.description.zh.length > 10)
  assert.equal(entry.metadata.category, 'workspace')
  assert.ok(index.metadata.categories.workspace.title.en.length > 0)
})

test('the inlined icon is the shipped icon and stays under the size limit', async () => {
  const index = await validatedIndex()
  const [entry] = index.plugins
  assert.match(entry.icon, /^data:image\/svg\+xml;base64,/)

  const payload = entry.icon.slice(entry.icon.indexOf(',') + 1)
  const decoded = Buffer.from(payload, 'base64').toString('utf8')
  const shipped = await readFile(new URL('icon.svg', ROOT), 'utf8')

  assert.equal(decoded, shipped, 'the index icon must be the icon the plugin ships')
  assert.ok(Buffer.from(payload, 'base64').length < 32 * 1024, 'inline icons are capped at 32 KiB decoded')
})

test('the index ships in the package so a publish also hosts it', async () => {
  const manifest = await readJson('package.json')
  assert.ok(manifest.files.includes('plugin-index.json'), 'files must include the index')
  // Shipping the index lets an npm publish serve it from a CDN at a direct URL,
  // which matters because the Discover tab refuses redirects.
  assert.ok(manifest.files.includes('client.js'), 'the client half must ship')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the bundle patch must ship')
  assert.ok((await stat(new URL('plugin-index.json', ROOT))).size > 0)
})
