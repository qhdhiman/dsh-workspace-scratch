/**
 * Offline tests for the settings layers, the persisted override file, and the
 * HTTP API the GUI settings page talks to. No DSH process is involved: the
 * routes are invoked with a small request/response double.
 *
 * Run with: npm test (the package script globs this directory)
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_CONFIG,
  EDITABLE_FIELDS,
  applyConfig,
  composeConfig,
  createApiRoutes,
  dshHome,
  readSettings,
  removeSettings,
  settingsFile,
  validateLayer,
  writeSettings,
} from '../settings.js'

/** A fresh temporary directory standing in for the harness home. */
async function home() {
  return mkdtemp(join(tmpdir(), 'ws-scratch-settings-'))
}

/** A request double: an async iterable body plus method and url. */
function request(method, url, body) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (text.length > 0) yield Buffer.from(text, 'utf8')
    },
  }
}

/** A response double capturing status, headers and body. */
function response() {
  const captured = { statusCode: 0, headers: {}, body: '' }
  return {
    set statusCode(value) {
      captured.statusCode = value
    },
    get statusCode() {
      return captured.statusCode
    },
    setHeader: (name, value) => {
      captured.headers[name.toLowerCase()] = value
    },
    end: (body) => {
      captured.body = body ?? ''
    },
    captured,
  }
}

/** Invoke one route and parse its JSON response. */
async function call(route, req) {
  const res = response()
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    // GET handlers answer through the route's own try/catch.
    await route.handler(req, res)
  } else {
    await route.handler(req, res)
  }
  // A refusal is plain text; a handler answer is JSON. Parse only what is JSON
  // so both shapes can be asserted on.
  const body = res.captured.body ?? ''
  let json = {}
  try {
    json = body === '' ? {} : JSON.parse(body)
  } catch {
    json = { raw: body }
  }
  return { status: res.captured.statusCode, headers: res.captured.headers, json, body: typeof body === 'string' ? body : String(body) }
}

/** Build the route table over an in-memory live config, like the plugin does. */
function harness(root, options = {}) {
  const file = join(root, 'workspace-scratch', 'settings.json')
  const rowLayer = options.rowLayer ?? {}
  const live = composeConfig(rowLayer)
  let reloads = 0
  const routes = createApiRoutes({
    rejectRequest: options.rejectRequest,
    effective: () => live,
    rowLayer: () => rowLayer,
    readStored: () => readSettings(file),
    writeStored: (values) => writeSettings(values, file),
    clearStored: () => removeSettings(file),
    settingsFile: () => file,
    warnings: () => options.warnings ?? [],
    reload: async () => {
      reloads += 1
      applyConfig(live, composeConfig(rowLayer, await readSettings(file)))
    },
  })
  const byPath = new Map(routes.map((route) => [route.path, route]))
  return { live, file, routes, byPath, reloads: () => reloads }
}

test('validateLayer accepts known fields and rejects the rest', () => {
  assert.deepEqual(validateLayer({ retentionDays: 3, tools: false }), { retentionDays: 3, tools: false })
  assert.deepEqual(validateLayer(undefined), {})
  assert.deepEqual(validateLayer({ retentionDays: undefined }), {}, 'an undefined value is not an override')
  assert.throws(() => validateLayer({ nope: 1 }), /not a supported field/)
  assert.throws(() => validateLayer({ retentionDays: 1.5 }), /retentionDays/)
  assert.throws(() => validateLayer({ tools: 'yes' }), /tools/)
  assert.throws(() => validateLayer({ dirName: '../x' }), /dirName/)
  assert.throws(() => validateLayer([]), /must be an object/)
})

test('composeConfig layers defaults, row and settings in order', () => {
  const row = { retentionDays: 30, dirName: '.scratch' }
  const stored = { retentionDays: 3 }
  const effective = composeConfig(row, stored)
  assert.equal(effective.retentionDays, 3, 'the settings layer wins')
  assert.equal(effective.dirName, '.scratch', 'the row layer still applies where settings are silent')
  assert.equal(effective.tools, DEFAULT_CONFIG.tools, 'defaults fill the rest')
})

test('applyConfig mirrors onto the live object in place', () => {
  const live = composeConfig()
  const identity = live
  applyConfig(live, composeConfig({ retentionDays: 2 }))
  assert.equal(live, identity, 'the object identity is preserved for closures')
  assert.equal(live.retentionDays, 2)
})

test('settings round-trip through the override file', async () => {
  const root = await home()
  const file = join(root, 'workspace-scratch', 'settings.json')

  assert.deepEqual(await readSettings(file), {}, 'a missing file is an empty layer')
  await writeSettings({ retentionDays: 5, gitExclude: false }, file)
  assert.deepEqual(await readSettings(file), { retentionDays: 5, gitExclude: false })

  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(onDisk, { retentionDays: 5, gitExclude: false })
  const mode = (await stat(file)).mode & 0o777
  assert.equal(mode, 0o600, 'the settings file is private')

  await removeSettings(file)
  assert.deepEqual(await readSettings(file), {})
})

test('a corrupt settings file is reported, not silently obeyed', async () => {
  const root = await home()
  const file = join(root, 'settings.json')
  await writeFile(file, '{ not json')
  await assert.rejects(() => readSettings(file), /not valid JSON/)
})

test('settingsFile lives in the harness home, never in the workspace', () => {
  const path = settingsFile()
  assert.ok(path.startsWith(dshHome()), `${path} should sit under ${dshHome()}`)
  assert.ok(path.endsWith('workspace-scratch/settings.json'))
  assert.ok(!path.includes('/default-workspace/'))
})

test('GET state reports every layer the page renders', async () => {
  const root = await home()
  const h = harness(root, { rowLayer: { retentionDays: 30 } })
  const state = await call(h.byPath.get('/workspace-scratch/api/state'), request('GET', '/workspace-scratch/api/state'))

  assert.equal(state.status, 200)
  assert.equal(state.json.ok, true)
  assert.equal(state.json.effective.retentionDays, 30)
  assert.equal(state.json.row.retentionDays, 30)
  assert.deepEqual(state.json.stored, {})
  assert.deepEqual(state.json.defaults, DEFAULT_CONFIG)
  assert.deepEqual(state.json.fields, EDITABLE_FIELDS)
  assert.equal(state.json.settingsFile, h.file)
  assert.deepEqual(state.json.warnings, [])
})

test('POST config persists the override and reloads the live config', async () => {
  const root = await home()
  const h = harness(root, { rowLayer: { retentionDays: 30 } })

  const saved = await call(h.byPath.get('/workspace-scratch/api/config'), request('POST', '/workspace-scratch/api/config', { retentionDays: 2 }))
  assert.equal(saved.status, 200)
  assert.equal(saved.json.stored.retentionDays, 2)
  assert.equal(saved.json.effective.retentionDays, 2)
  assert.equal(h.live.retentionDays, 2, 'the live object tools read is updated')
  assert.equal(h.reloads(), 1)
  assert.deepEqual(JSON.parse(await readFile(h.file, 'utf8')), { retentionDays: 2 })
})

test('POST config merges into existing overrides instead of replacing them', async () => {
  const root = await home()
  const h = harness(root)
  await call(h.byPath.get('/workspace-scratch/api/config'), request('POST', '/workspace-scratch/api/config', { retentionDays: 2 }))
  await call(h.byPath.get('/workspace-scratch/api/config'), request('POST', '/workspace-scratch/api/config', { gitExclude: false }))

  assert.deepEqual(JSON.parse(await readFile(h.file, 'utf8')), { retentionDays: 2, gitExclude: false })
  assert.equal(h.live.gitExclude, false)
})

test('POST config refuses an unusable value and keeps the file untouched', async () => {
  const root = await home()
  const h = harness(root)
  await call(h.byPath.get('/workspace-scratch/api/config'), request('POST', '/workspace-scratch/api/config', { retentionDays: 2 }))

  const refused = await call(h.byPath.get('/workspace-scratch/api/config'), request('POST', '/workspace-scratch/api/config', { retentionDays: -1 }))
  assert.equal(refused.status, 400)
  assert.equal(refused.json.ok, false)
  assert.match(refused.json.message, /retentionDays/)
  assert.deepEqual(JSON.parse(await readFile(h.file, 'utf8')), { retentionDays: 2 }, 'the earlier override survives')
})

test('POST config refuses a non-object body', async () => {
  const root = await home()
  const h = harness(root)
  const refused = await call(h.byPath.get('/workspace-scratch/api/config'), request('POST', '/workspace-scratch/api/config', '[1,2]'))
  assert.equal(refused.status, 400)
})

test('POST reset clears every override', async () => {
  const root = await home()
  const h = harness(root, { rowLayer: { retentionDays: 30 } })
  await call(h.byPath.get('/workspace-scratch/api/config'), request('POST', '/workspace-scratch/api/config', { retentionDays: 2 }))
  assert.equal(h.live.retentionDays, 2)

  const reset = await call(h.byPath.get('/workspace-scratch/api/reset'), request('POST', '/workspace-scratch/api/reset', {}))
  assert.equal(reset.status, 200)
  assert.deepEqual(reset.json.stored, {})
  assert.equal(reset.json.effective.retentionDays, 30, 'the row layer shows through again')
  assert.equal(h.live.retentionDays, 30)
})

test('POST reset with keys clears only those overrides', async () => {
  const root = await home()
  const h = harness(root)
  await call(h.byPath.get('/workspace-scratch/api/config'), request('POST', '/workspace-scratch/api/config', { retentionDays: 2, gitExclude: false }))

  const reset = await call(h.byPath.get('/workspace-scratch/api/reset'), request('POST', '/workspace-scratch/api/reset', { keys: ['retentionDays'] }))
  assert.deepEqual(reset.json.stored, { gitExclude: false })
  assert.equal(reset.json.effective.retentionDays, DEFAULT_CONFIG.retentionDays)
})

test('unsupported methods are refused with 405', async () => {
  const root = await home()
  const h = harness(root)
  const refused = await call(h.byPath.get('/workspace-scratch/api/state'), request('DELETE', '/workspace-scratch/api/state'))
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'GET, HEAD, POST')
})

test('a corrupt settings file surfaces as a warning instead of breaking state', async () => {
  const root = await home()
  const file = join(root, 'workspace-scratch', 'settings.json')
  await writeSettings({ retentionDays: 2 }, file)
  await writeFile(file, '{ broken')

  const h = harness(root, { warnings: ['workspace-scratch: settings file is not valid JSON'] })
  const state = await call(h.byPath.get('/workspace-scratch/api/state'), request('GET', '/workspace-scratch/api/state'))
  assert.equal(state.status, 200)
  assert.match(state.json.warnings[0], /not valid JSON/)
})

test('every route passes the GUI admission gate before doing anything', async () => {
  const root = await home()
  const h = harness(root, { rejectRequest: () => 401 })

  for (const path of ['/workspace-scratch/api/state', '/workspace-scratch/api/config', '/workspace-scratch/api/reset']) {
    const req = path.endsWith('state') ? request('GET', path) : request('POST', path, {})
    const refused = await call(h.byPath.get(path), req)
    assert.equal(refused.status, 401, `${path} must refuse an unauthenticated caller`)
    assert.equal(refused.headers['cache-control'], 'no-store')
    assert.match(refused.body ?? '', /authentication required/)
  }

  // Nothing was written, and the live config never reloaded.
  await assert.rejects(() => stat(h.file), /ENOENT/)
  assert.equal(h.reloads(), 0)
})

test('a trusted request reaches the handler unchanged', async () => {
  const root = await home()
  const h = harness(root, { rejectRequest: () => undefined })
  const state = await call(h.byPath.get('/workspace-scratch/api/state'), request('GET', '/workspace-scratch/api/state'))
  assert.equal(state.status, 200)
  assert.equal(state.json.ok, true)
})

test('an untrusted origin is refused with 403', async () => {
  const root = await home()
  const h = harness(root, { rejectRequest: () => 403 })
  const refused = await call(h.byPath.get('/workspace-scratch/api/state'), request('GET', '/workspace-scratch/api/state'))
  assert.equal(refused.status, 403)
  assert.match(refused.body ?? '', /forbidden/)
})
