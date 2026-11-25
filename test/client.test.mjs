/**
 * Offline contract test for the client half: it must register into the
 * `settings.section` slot under the package's own id, expose `inject: ['slots']`
 * so the client kernel waits for the slot service, and leave nothing behind
 * when it is disposed. No browser and no React are involved — the module
 * format and the registration lifecycle are what this pins.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url))

/** Minimal React stand-in: the factory only needs createElement and hooks. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
}

/**
 * Load client.js the way the kernel does: a global module loader captures the
 * factory, which is then materialized with a `require` that serves `react`.
 */
async function loadClient() {
  const source = await readFile(CLIENT, 'utf8')
  const registrations = []
  const window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    __ModuleLoader__: {
      load: (definition) => registrations.push(definition),
    },
  }

  // The bundle is a classic script that reads and writes `window`; run it with
  // that object as its global binding.
  const run = new Function('window', 'document', 'fetch', source)
  run(window, { createElement: () => ({ remove: () => {} }), head: { appendChild: () => {} } }, () => Promise.reject(new Error('no network in tests')))

  assert.equal(registrations.length, 1, 'the bundle registers exactly one factory')
  const definition = registrations[0]
  const module = definition.factory((specifier) => {
    if (specifier === 'react') return reactStub
    throw new Error(`unexpected module request: ${specifier}`)
  })
  return { definition, module }
}

test('the client bundle registers under the package name', async () => {
  const pkg = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const { definition } = await loadClient()
  assert.equal(definition.id, pkg.name, '__ModuleLoader__ id must equal the package name')
  assert.ok(pkg.exports['./client'], 'the manifest exports ./client')
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('the client half declares the slots service and a disposer-backed apply', async () => {
  const { module } = await loadClient()
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.apply, 'function')
})

test('apply registers one Settings page and disposes cleanly', async () => {
  const { module } = await loadClient()
  const effects = []
  const registrations = []
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    slots: {
      inject: (name, register) => {
        assert.equal(name, 'settings.section')
        return register()
      },
      register: (entry, component) => {
        registrations.push({ entry, component })
        return () => registrations.pop()
      },
    },
  }

  module.apply(ctx)
  assert.equal(registrations.length, 1, 'exactly one page is registered')
  assert.equal(registrations[0].entry.name, 'settings.section')
  assert.equal(registrations[0].entry.id, 'workspace-scratch')
  assert.equal(typeof registrations[0].entry.order, 'number')
  assert.equal(typeof registrations[0].entry.label, 'string')
  assert.ok(registrations[0].entry.label.length > 0)
  assert.equal(typeof registrations[0].component, 'function', 'a component is registered')

  // Dropping the effect must unregister the page.
  assert.equal(effects.length, 1)
  assert.equal(typeof effects[0], 'function')
  effects[0]()
  assert.equal(registrations.length, 0, 'disposal removes the page')
})

test('the page requests its own host API and nothing else', async () => {
  const source = await readFile(CLIENT, 'utf8')
  assert.match(source, /fetch\(`\/workspace-scratch\/api\/\$\{/, 'requests are built on the plugin\'s own base path')

  // Every request goes through the one helper, and the only endpoints it
  // names are the three the host half registers.
  for (const endpoint of ['state', 'config', 'reset']) {
    assert.ok(source.includes("api('" + endpoint + "'"), `the page calls ${endpoint}`)
  }
  const endpoints = [...source.matchAll(/api\('([a-z]+)'/g)].map((match) => match[1])
  assert.deepEqual([...new Set(endpoints)].sort(), ['config', 'reset', 'state'])

  // No other absolute path is fetched, so the page cannot reach outside its half.
  const fetches = [...source.matchAll(/fetch\(([^,)]+)/g)].map((match) => match[1].trim())
  for (const target of fetches) assert.match(target, /^`\/workspace-scratch\/api\//)
})

test('the client bundle imports no DSH package', async () => {
  const source = await readFile(CLIENT, 'utf8')
  assert.doesNotMatch(source, /require\(['"]@deepseek-ai\//, 'a link:-ed package cannot resolve DSH packages at runtime')
})

test('display metadata is present and specific in both locales', async () => {
  const locales = ['locale/en.json', 'locale/zh.json']
  for (const relative of locales) {
    const path = fileURLToPath(new URL(`../${relative}`, import.meta.url))
    const document = JSON.parse(await readFile(path, 'utf8'))
    assert.ok(document.meta.title.length > 0, `${relative} has a title`)
    assert.ok(document.meta.description.length > 20, `${relative} has a real description`)
    assert.doesNotMatch(document.meta.title, /my-|template|decoration/i, `${relative} keeps no template copy`)
  }
})

test('the icon is well-formed XML, square, on-brand and inside the size limit', async () => {
  const pkg = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const iconPath = fileURLToPath(new URL(`../${pkg.icon.replace(/^\.\//, '')}`, import.meta.url))
  const raw = await readFile(iconPath, 'utf8')

  // A malformed SVG still installs and still lists, but renders nothing, so the
  // page shows blank artwork with no error — pin well-formedness here.
  assert.doesNotMatch(raw, /<!--[\s\S]*?--[\s\S]*?-->/, 'an XML comment may not contain "--"')
  assert.match(raw, /^<svg[\s>]/, 'the file starts with the svg root element')
  assert.match(raw, /<\/svg>\s*$/, 'the file closes the svg root element')

  const viewBox = /viewBox="([^"]+)"/.exec(raw)[1].split(/[\s,]+/).map(Number)
  assert.equal(viewBox.length, 4)
  assert.ok(Math.abs(viewBox[2] / viewBox[3] - 1) < 0.02, `the icon must be square, got ${viewBox[2]}x${viewBox[3]}`)

  const width = Number(/<svg[^>]*\swidth="(\d+)"/.exec(raw)[1])
  const height = Number(/<svg[^>]*\sheight="(\d+)"/.exec(raw)[1])
  assert.ok(Math.abs(width / height - 1) < 0.02, 'the declared width and height are equal')

  const colors = [...new Set(raw.match(/#[0-9a-fA-F]{6}/g))]
  assert.deepEqual(colors, ['#4176e6'], 'the DeepSeek brand blue is the only color')

  const { stat } = await import('node:fs/promises')
  assert.ok((await stat(iconPath)).size < 256 * 1024, 'icons must stay under 256 KiB')
})
