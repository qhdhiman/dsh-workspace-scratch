/**
 * Offline smoke test for the workspace-scratch plugin: a fake plugin context
 * exercises registration, layout creation, both tools, path safety, the git
 * exclude entry, pruning and config validation — no DSH process required.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, inject, name } from '../index.js'

// The plugin reads its settings layer from the harness home at activation.
// Point that at a scratch directory so a developer's real settings file can
// never change what these tests observe.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'ws-scratch-home-'))

/** Build a plugin context that records what the plugin registers. */
function fakeCtx({ cwd = process.cwd() } = {}) {
  const tools = new Map()
  const sections = new Map()
  const contexts = new Map()
  const listeners = new Map()
  const warnings = []
  const whens = new Map()
  const ctx = {
    logger: { warn: (message) => warnings.push(message), info() {} },
    get: (serviceName) => (serviceName === 'profileContext' ? { cwd } : undefined),
    on: (event, listener) => listeners.set(event, listener),
    agents: { list: () => [] },
    systemPrompt: {
      section: (section) => sections.set(section.name, section),
      context: (context) => contexts.set(context.name, context),
    },
    tools: { register: (definition, options) => { tools.set(definition.name, definition); whens.set(definition.name, options?.when) } },
  }
  return { ctx, tools, sections, contexts, listeners, warnings, whens }
}

/** A session handle as the plugin sees it through `agent/created`. */
function fakeAgent(cwd, id = 'session-abc') {
  return { session: { id, header: { cwd } } }
}

/** A fresh temporary workspace directory. */
async function workspace(prefix = 'ws-scratch-') {
  return mkdtemp(join(tmpdir(), prefix))
}

test('declares its Cordis identity', () => {
  assert.equal(name, 'workspace-scratch')
  assert.deepEqual([...inject].sort(), ['agents', 'systemPrompt', 'tools'])
})

test('creates the .dsh layout, guidance and both tools', async () => {
  const ws = await workspace()
  const agent = fakeAgent(ws)
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, {})

  assert.deepEqual([...harness.tools.keys()].sort(), ['memory', 'scratch'])
  assert.ok(harness.sections.has('workspace-scratch:guidance'))
  assert.ok(harness.contexts.has('workspace-scratch:paths'))

  await harness.listeners.get('agent/created')({ agent })

  for (const relative of ['.dsh', '.dsh/tmp/session-abc', '.dsh/memory']) {
    const info = await stat(join(ws, relative))
    assert.ok(info.isDirectory(), `${relative} should be a directory`)
  }
  assert.equal(await readFile(join(ws, '.dsh', '.gitignore'), 'utf8'), '*\n')

  const contextText = harness.contexts.get('workspace-scratch:paths').text({ agent })
  assert.match(contextText, /\.dsh\/tmp\/session-abc/)
  assert.match(contextText, /\.dsh\/memory/)

  const guidance = harness.sections.get('workspace-scratch:guidance').text()
  assert.match(guidance, /scratch/)
  assert.match(guidance, /memory/)
})

test('the scratch tool writes, reads, lists and deletes inside the session directory', async () => {
  const ws = await workspace()
  const agent = fakeAgent(ws)
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, {})
  await harness.listeners.get('agent/created')({ agent })
  const scratch = harness.tools.get('scratch')
  const exec = { agent, signal: undefined }

  const written = await scratch.execute({ action: 'write', path: 'nested/report.txt', content: 'hello' }, exec)
  assert.match(written, /wrote .*\.dsh\/tmp\/session-abc\/nested\/report\.txt/)
  assert.equal(await readFile(join(ws, '.dsh', 'tmp', 'session-abc', 'nested', 'report.txt'), 'utf8'), 'hello')

  const read = await scratch.execute({ action: 'read', path: 'nested/report.txt' }, exec)
  assert.match(read, /hello/)

  await scratch.execute({ action: 'write', path: 'nested/report.txt', content: ' more', append: true }, exec)
  assert.equal(await readFile(join(ws, '.dsh', 'tmp', 'session-abc', 'nested', 'report.txt'), 'utf8'), 'hello more')

  const listed = await scratch.execute({ action: 'list' }, exec)
  assert.match(listed, /nested\//)
  assert.match(listed, /nested\/report\.txt/)

  await scratch.execute({ action: 'delete', path: 'nested' }, exec)
  await assert.rejects(() => stat(join(ws, '.dsh', 'tmp', 'session-abc', 'nested')))
})

test('paths cannot escape the session scratch directory', async () => {
  const ws = await workspace()
  const agent = fakeAgent(ws)
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, {})
  const scratch = harness.tools.get('scratch')
  const exec = { agent }

  await assert.rejects(() => scratch.execute({ action: 'write', path: '../../escape.txt', content: 'x' }, exec), /must stay inside/)
  await assert.rejects(() => scratch.execute({ action: 'read', path: '/etc/passwd' }, exec), /must be relative/)
  await assert.rejects(() => scratch.execute({ action: 'write', content: 'x' }, exec), /path must be a non-empty path/)
  await assert.rejects(() => scratch.execute({ action: 'nonsense' }, exec), /unknown action/)
  await assert.rejects(() => stat(join(ws, 'escape.txt')))
})

test('the memory tool saves, indexes, searches and deletes durable notes', async () => {
  const ws = await workspace()
  const agent = fakeAgent(ws)
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, {})
  const memory = harness.tools.get('memory')
  const exec = { agent }

  await memory.execute({ action: 'save', name: 'Build commands', content: '# Build commands\nalways run pnpm test\n' }, exec)
  await memory.execute({ action: 'save', name: 'user-preferences.md', content: '# Preferences\nPrefers Chinese replies\n' }, exec)

  assert.equal(await readFile(join(ws, '.dsh', 'memory', 'Build-commands.md'), 'utf8'), '# Build commands\nalways run pnpm test\n')
  const index = await readFile(join(ws, '.dsh', 'memory', 'MEMORY.md'), 'utf8')
  assert.match(index, /Build commands/)
  assert.match(index, /Preferences/)

  const listed = await memory.execute({ action: 'list' }, exec)
  assert.match(listed, /Workspace memory index/)

  const read = await memory.execute({ action: 'read', name: 'build commands' }, exec)
  assert.match(read, /always run pnpm test/)

  const found = await memory.execute({ action: 'search', query: 'CHINESE' }, exec)
  assert.match(found, /user-preferences\.md:2/)

  await memory.execute({ action: 'delete', name: 'user-preferences' }, exec)
  const afterDelete = await readFile(join(ws, '.dsh', 'memory', 'MEMORY.md'), 'utf8')
  assert.doesNotMatch(afterDelete, /Preferences/)
  await assert.rejects(() => stat(join(ws, '.dsh', 'memory', 'user-preferences.md')))
})

test('a git workspace gets a /.dsh/ exclude entry', async () => {
  const ws = await workspace()
  await mkdir(join(ws, '.git', 'info'), { recursive: true })
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, {})
  await harness.listeners.get('agent/created')({ agent: fakeAgent(ws) })

  const exclude = await readFile(join(ws, '.git', 'info', 'exclude'), 'utf8')
  assert.match(exclude, /^\/\.dsh\/$/m)
  assert.equal(exclude.match(/^\/\.dsh\/$/gm).length, 1, 'the marker is written once')
})

test('stale session scratch directories are pruned', async () => {
  const ws = await workspace()
  const stale = join(ws, '.dsh', 'tmp', 'old-session')
  await mkdir(stale, { recursive: true })
  await writeFile(join(stale, 'leftover.txt'), 'x')
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  await utimes(stale, monthAgo, monthAgo)

  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, { retentionDays: 7 })
  await harness.listeners.get('agent/created')({ agent: fakeAgent(ws, 'fresh-session') })

  await assert.rejects(() => stat(stale), /ENOENT/)
  assert.ok((await stat(join(ws, '.dsh', 'tmp', 'fresh-session'))).isDirectory())
})

test('agents without a recorded cwd fall back to the profile directory', async () => {
  const ws = await workspace()
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, {})
  await harness.listeners.get('agent/created')({ agent: { session: { id: 'orphan', header: {} } } })
  assert.ok((await stat(join(ws, '.dsh', 'tmp', 'orphan'))).isDirectory())
})

test('unusable config is rejected at load time', async () => {
  const ws = await workspace()
  await assert.rejects(() => apply(fakeCtx({ cwd: ws }).ctx, { retentionDays: -1 }), /retentionDays/)
  await assert.rejects(() => apply(fakeCtx({ cwd: ws }).ctx, { dirName: '../outside' }), /dirName/)
  await assert.rejects(() => apply(fakeCtx({ cwd: ws }).ctx, { tools: 'yes' }), /tools/)
  await assert.rejects(() => apply(fakeCtx({ cwd: ws }).ctx, []), /must be an object/)
})

test('tools are registered but hidden per step when disabled', async () => {
  const ws = await workspace()
  const agent = fakeAgent(ws)
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, { tools: false })

  // Always registered, so a settings toggle needs no re-registration...
  assert.deepEqual([...harness.tools.keys()].sort(), ['memory', 'scratch'])
  // ...and invisible to the model while the switch is off.
  assert.equal(harness.whens.get('scratch')(), false)
  assert.equal(harness.whens.get('memory')(), false)

  await harness.listeners.get('agent/created')({ agent })
  assert.ok((await stat(join(ws, '.dsh', 'tmp', 'session-abc'))).isDirectory())
})

test('each tool toggle hides only its own tool', async () => {
  const ws = await workspace()
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, { scratchTool: false })
  assert.equal(harness.whens.get('scratch')(), false)
  assert.equal(harness.whens.get('memory')(), true)
})

test('prompt guidance disappears when promptGuidance is off', async () => {
  const ws = await workspace()
  const agent = fakeAgent(ws)
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, { promptGuidance: false })
  assert.equal(harness.sections.get('workspace-scratch:guidance').text(), '')
  assert.equal(harness.contexts.get('workspace-scratch:paths').text({ agent }), '')
})

test('the memory index never indexes itself and its name is reserved', async () => {
  const ws = await workspace()
  const agent = fakeAgent(ws)
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, {})
  const memory = harness.tools.get('memory')
  const exec = { agent }

  await memory.execute({ action: 'save', name: 'first', content: '# First\nbody\n' }, exec)
  await memory.execute({ action: 'save', name: 'second', content: '# Second\nbody\n' }, exec)

  const index = await readFile(join(ws, '.dsh', 'memory', 'MEMORY.md'), 'utf8')
  assert.doesNotMatch(index, /\(MEMORY\.md\)/, 'the index must not list itself')
  assert.equal(index.match(/^- \[/gm).length, 2, 'exactly the two real notes are indexed')

  // A note may not overwrite the index under any casing.
  await assert.rejects(() => memory.execute({ action: 'save', name: 'MEMORY', content: '# x' }, exec), /reserved/)
  await assert.rejects(() => memory.execute({ action: 'save', name: 'memory.md', content: '# x' }, exec), /reserved/)

  // Search must not match the index file.
  const found = await memory.execute({ action: 'search', query: 'Workspace memory index' }, exec)
  assert.match(found, /No memory note matches/)

  // Restoring the note named "MEMORY.md" as a real note stays impossible after deletion too.
  await memory.execute({ action: 'delete', name: 'first' }, exec)
  const after = await readFile(join(ws, '.dsh', 'memory', 'MEMORY.md'), 'utf8')
  assert.doesNotMatch(after, /\(MEMORY\.md\)/)
  assert.equal(after.match(/^- \[/gm).length, 1)
})

test('memory index timestamps use local time, not UTC', async () => {
  const ws = await workspace()
  const agent = fakeAgent(ws)
  const harness = fakeCtx({ cwd: ws })
  await apply(harness.ctx, {})
  await harness.tools.get('memory').execute({ action: 'save', name: 'stamped', content: '# Stamped\n' }, { agent })

  const index = await readFile(join(ws, '.dsh', 'memory', 'MEMORY.md'), 'utf8')
  const now = new Date()
  const pad = (v) => String(v).padStart(2, '0')
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  assert.match(index, new RegExp(local), `index should carry the local date ${local}`)
})
