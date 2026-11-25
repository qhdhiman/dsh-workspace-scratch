/**
 * dsh-workspace-scratch — keep a workspace clean by giving every session a
 * private `.dsh/` home for scratch files and durable memory notes.
 *
 * Behaviour:
 * - On plugin activation and on every `agent/created`, the workspace root of the
 *   session gets `.dsh/` with `tmp/<session>/` and `memory/`, a `.dsh/.gitignore`
 *   that hides its contents from git, and (when the workspace is a git checkout)
 *   a `/.dsh/` entry in `.git/info/exclude`.
 * - Old `<session>/` scratch directories are pruned after `retentionDays`.
 * - Two model-facing tools, `scratch` and `memory`, read and write only inside
 *   `.dsh/`; every path is resolved and checked so nothing can escape it.
 * - A system-prompt section and a runtime-context line tell the model the rule
 *   and the exact directories of the current session.
 *
 * The plugin imports nothing from `@deepseek-ai/*`: every DSH service is read
 * through the plugin context, and the two tools are declared with plain JSON
 * Schema objects, so the package installs and loads without extra dependencies.
 */

import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import {
  applyConfig as mirrorConfig,
  composeConfig,
  createApiRoutes,
  readSettings,
  removeSettings,
  settingsFile,
  validateLayer,
  writeSettings,
} from './settings.js'

/** Stable Cordis plugin name. */
export const name = 'workspace-scratch'

/** Services this plugin needs: the agent registry, prompt registry and tool registry. */
export const inject = ['agents', 'systemPrompt', 'tools']

/** File name of the human-readable memory index inside the memory directory. */
const MEMORY_INDEX = 'MEMORY.md'

/** Case-insensitive identity of the reserved index file name, for filesystem comparisons. */
const MEMORY_INDEX_UPPER = MEMORY_INDEX.toUpperCase()

/** Prompt section order: just after the terminal guidance, before web tools. */
const SECTION_ORDER = 1750

/** Runtime-context order: after the team identity, before harness facts. */
const CONTEXT_ORDER = 130

/** Pruning is attempted at most once per hour for a given workspace root. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

/** Hard ceiling for one scratch read or memory read, in bytes. */
const READ_MAX_BYTES = 64 * 1024

/** Hard ceiling for entries returned by a recursive scratch listing. */
const LIST_MAX_ENTRIES = 200

/** Warn through the plugin logger without ever failing the caller. */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`workspace-scratch: ${message}`)
  } catch {
    /* logging must never break the plugin */
  }
}

/** Read a DSH service, tolerating compositions that do not mount it. */
function service(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/** The workspace root a session was opened in: its recorded `cwd`, never a later `cd`. */
function workspaceRootOf(ctx, agent) {
  const recorded = agent?.session?.header?.cwd
  if (typeof recorded === 'string' && isAbsolute(recorded)) return recorded
  const profileContext = service(ctx, 'profileContext')
  const fallback = profileContext?.cwd
  if (typeof fallback === 'string' && isAbsolute(fallback)) return fallback
  return process.cwd()
}

/** Filesystem-safe directory name for one session's scratch files. */
function sessionKeyOf(agent, sharedKey) {
  const raw = agent?.session?.id
  const id = typeof raw === 'string' ? raw : String(raw ?? '')
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 96)
  return safe.length > 0 ? safe : sharedKey
}

/**
 * Resolve the layout of one session's `.dsh` home.
 * @returns every absolute path the plugin and its tools use for that session.
 */
function layoutFor(ctx, cfg, agent, sharedKey = 'default') {
  const root = workspaceRootOf(ctx, agent)
  if (dirname(root) === root) throw new Error(`workspace-scratch: refusing to manage ${JSON.stringify(root)}: it is a filesystem root`)
  const base = join(root, cfg.dirName)
  const tmp = join(base, cfg.tmpDirName)
  const memory = join(base, cfg.memoryDirName)
  const sessionKey = sessionKeyOf(agent, sharedKey)
  return { root, base, tmp, memory, sessionKey, scratch: join(tmp, sessionKey) }
}

/** Write a file only when it is absent, keeping user edits intact. */
async function ensureFile(path, content) {
  try {
    await stat(path)
    return false
  } catch {
    await writeFile(path, content, { encoding: 'utf8', mode: 0o644 })
    return true
  }
}

/** Keep `.dsh/` out of `git status` without touching the repository's tracked files. */
async function ensureGitExclude(ctx, root, dirName) {
  try {
    const gitDir = join(root, '.git')
    const info = await stat(gitDir)
    if (!info.isDirectory()) return
    const excludeFile = join(gitDir, 'info', 'exclude')
    const marker = `/${dirName}/`
    let existing = ''
    try {
      existing = await readFile(excludeFile, 'utf8')
    } catch {
      await mkdir(dirname(excludeFile), { recursive: true })
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === marker)) return
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    await appendFile(excludeFile, `${prefix}# DeepSeek Harness session scratch and memory (workspace-scratch plugin)\n${marker}\n`, 'utf8')
  } catch (error) {
    warn(ctx, `could not update .git/info/exclude: ${String(error)}`)
  }
}

/** Create the `.dsh` layout for one session, idempotently. */
async function ensureLayout(ctx, cfg, agent, options = {}) {
  const layout = layoutFor(ctx, cfg, agent, options.sharedKey)
  await mkdir(layout.scratch, { recursive: true, mode: 0o755 })
  await mkdir(layout.memory, { recursive: true, mode: 0o755 })
  if (cfg.writeGitIgnore) await ensureFile(join(layout.base, '.gitignore'), '*\n')
  if (cfg.gitExclude) await ensureGitExclude(ctx, layout.root, cfg.dirName)
  await pruneScratch(ctx, cfg, layout, options.now)
  return layout
}

/**
 * Delete session scratch directories that have not been touched for
 * `retentionDays`. The active session is always kept.
 */
async function pruneScratch(ctx, cfg, layout, now = Date.now()) {
  if (cfg.retentionDays <= 0) return
  const last = pruneState.get(layout.root) ?? 0
  if (now - last < PRUNE_INTERVAL_MS) return
  pruneState.set(layout.root, now)
  const cutoff = now - cfg.retentionDays * 24 * 60 * 60 * 1000
  let entries
  try {
    entries = await readdir(layout.tmp, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === layout.sessionKey) continue
    const path = join(layout.tmp, entry.name)
    try {
      const info = await stat(path)
      if (info.mtimeMs >= cutoff) continue
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      warn(ctx, `could not prune ${path}: ${String(error)}`)
    }
  }
}

/** Last pruning attempt per workspace root, so one layout never scans on every step. */
const pruneState = new Map()

/** Resolve `relative` inside `root`, refusing anything that climbs out. */
function resolveInside(root, relative, label) {
  if (typeof relative !== 'string' || relative.length === 0) throw new Error(`workspace-scratch: ${label} must be a non-empty path`)
  if (isAbsolute(relative)) throw new Error(`workspace-scratch: ${label} must be relative to the session directory, received ${JSON.stringify(relative)}`)
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`workspace-scratch: ${label} must stay inside the session directory, received ${JSON.stringify(relative)}`)
  }
  return target
}

/** Model-facing path: relative to the workspace root, with forward slashes. */
function displayPath(root, path) {
  const relative = path === root ? '.' : path.slice(root.length + 1)
  return relative.split(sep).join('/')
}

/** Turn a memory note name into one `*.md` file name. */
function memoryFileName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) throw new Error('workspace-scratch: name must be a non-empty memory note name')
  const trimmed = name.trim().replace(/\.md$/i, '')
  const slug = trimmed
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
  if (slug.length === 0) throw new Error(`workspace-scratch: ${JSON.stringify(name)} has no usable characters for a memory file name`)
  const file = `${slug}.md`
  if (file.toUpperCase() === MEMORY_INDEX_UPPER) throw new Error(`workspace-scratch: ${JSON.stringify(MEMORY_INDEX)} is reserved for the memory index`)
  return file
}

/** Read a text file with a byte ceiling instead of buffering it whole. */
async function readCapped(path) {
  const info = await stat(path)
  const content = await readFile(path, 'utf8')
  if (Buffer.byteLength(content, 'utf8') <= READ_MAX_BYTES) return { content, truncated: false, totalBytes: info.size }
  return { content: content.slice(0, READ_MAX_BYTES), truncated: true, totalBytes: info.size }
}

/** Walk a directory tree, returning entries in stable path order. */
async function walk(current, depth = 0, out = []) {
  if (out.length >= LIST_MAX_ENTRIES) return out
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    if (out.length >= LIST_MAX_ENTRIES) return out
    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      out.push({ path, directory: true })
      if (depth < 6) await walk(path, depth + 1, out)
    } else {
      out.push({ path, directory: false })
    }
  }
  return out
}

/** Format a byte count for a one-line listing. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/** Whether a directory entry is a memory note rather than the reserved index file. */
function isNoteFile(entry) {
  return entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toUpperCase() !== MEMORY_INDEX_UPPER
}

/** Format a date as `YYYY-MM-DD HH:MM` in the process time zone. */
function localTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Rebuild `MEMORY.md` from the notes on disk so the index never drifts. */
async function rebuildMemoryIndex(layout) {
  let entries
  try {
    entries = await readdir(layout.memory, { withFileTypes: true })
  } catch {
    entries = []
  }
  const notes = entries
    .filter(isNoteFile)
    .map((entry) => entry.name)
    .sort()
  const rows = []
  for (const file of notes) {
    const path = join(layout.memory, file)
    let title = file.replace(/\.md$/i, '')
    let updated = ''
    try {
      const { content } = await readCapped(path)
      const heading = content.split(/\r?\n/).find((line) => /^#\s+\S/.test(line.trim()))
      const firstText = content.split(/\r?\n/).find((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
      title = (heading ? heading.replace(/^#\s+/, '') : firstText ?? title).trim().slice(0, 100)
      updated = localTimestamp((await stat(path)).mtime)
    } catch {
      /* an unreadable note still gets an index row */
    }
    rows.push(`- [${title}](${encodeURI(file)})${updated ? ` — updated ${updated}` : ''}`)
  }
  const body = [
    '# Workspace memory index',
    '',
    'Durable notes kept by the workspace-scratch plugin. Every note lives next to this',
    'index inside the workspace `.dsh` directory, so the workspace itself stays clean.',
    '',
    rows.length > 0 ? rows.join('\n') : '_No notes yet._',
    '',
  ].join('\n')
  await writeFile(join(layout.memory, MEMORY_INDEX), body, { encoding: 'utf8', mode: 0o644 })
}

/** Model-facing guidance about where scratch and memory files belong. */
function guidanceText(cfg, withTools) {
  const base = cfg.dirName
  const scratch = `${base}/${cfg.tmpDirName}/<session>`
  const memory = `${base}/${cfg.memoryDirName}`
  const lines = [
    `Keep this workspace clean: temporary files and memory notes live under the workspace's \`${base}\` directory, never in the workspace root or its source directories.`,
    '',
    `- Temporary files — scripts, generated samples, intermediate output, downloads, logs, screenshots — belong in \`${scratch}/\`.`,
    `- Durable notes that should survive this session — user preferences, project facts, decisions, useful commands — belong in \`${memory}/\`.`,
    '- When a command must write a file, point it into the session scratch directory instead of the workspace root.',
    `- \`${base}\` is hidden from git; do not add it to version control and do not remove it.`,
  ]
  if (withTools) {
    lines.push(
      '',
      'Use the `scratch` tool for temporary files and the `memory` tool for durable notes. Both take paths relative to their own directory, keep the workspace clean automatically, and are the only supported way to write there.',
    )
  }
  return lines.join('\n')
}

/** Runtime-context line naming the two directories of the current session. */
function contextText(ctx, cfg, agent) {
  if (!agent) return ''
  let layout
  try {
    layout = layoutFor(ctx, cfg, agent, 'default')
  } catch {
    return ''
  }
  return `Session scratch directory: ${JSON.stringify(layout.scratch)}. Workspace memory directory: ${JSON.stringify(layout.memory)}.`
}

/** Minimal tool-definition builder; equivalent in shape to DSH's `defineTool`. */
function defineTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: { schema: definition.output.schema, render: definition.output.render },
    ...(definition.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: definition.isConcurrencySafe }),
    execute: (args, exec) => definition.execute(args, exec),
  }
}

/** A single string result rendered as one text block. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/** Resolve the layout a tool call works on, creating it when missing. */
async function toolLayout(ctx, cfg, exec) {
  const layout = layoutFor(ctx, cfg, exec?.agent, 'default')
  await mkdir(layout.scratch, { recursive: true, mode: 0o755 })
  await mkdir(layout.memory, { recursive: true, mode: 0o755 })
  return layout
}

/** Build the `scratch` tool: temporary files under `.dsh/tmp/<session>/`. */
function scratchTool(ctx, cfg) {
  return defineTool({
    name: 'scratch',
    description: `Create, read, list and delete temporary files in this session's scratch directory (${cfg.dirName}/${cfg.tmpDirName}/<session>/). Use it for scripts, intermediate output, downloads, logs and generated samples so the workspace root stays clean. Paths are relative to the scratch directory.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'read', 'list', 'delete'],
          description: 'write a file, read a file, list the scratch tree, or delete a file or directory.',
        },
        path: { type: 'string', description: 'Path relative to the scratch directory; required for write, read and delete.' },
        content: { type: 'string', description: 'Text to write; required for write.' },
        append: { type: 'boolean', description: 'Append instead of replacing the file (write only).' },
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const layout = await toolLayout(ctx, cfg, exec)
      const action = args?.action
      const signal = exec?.signal
      if (action === 'write') {
        const path = resolveInside(layout.scratch, args?.path, 'path')
        if (typeof args?.content !== 'string') throw new Error('workspace-scratch: content must be a string when action is "write"')
        await mkdir(dirname(path), { recursive: true, mode: 0o755 })
        if (args.append === true) {
          await appendFile(path, args.content, { encoding: 'utf8' })
        } else {
          await writeFile(path, args.content, { encoding: 'utf8', mode: 0o644 })
        }
        const bytes = Buffer.byteLength(args.content, 'utf8')
        signal?.throwIfAborted?.()
        return `${args.append === true ? 'appended' : 'wrote'} ${displayPath(layout.root, path)} (${formatBytes(bytes)})`
      }
      if (action === 'read') {
        const path = resolveInside(layout.scratch, args?.path, 'path')
        const { content, truncated, totalBytes } = await readCapped(path)
        signal?.throwIfAborted?.()
        const header = `${displayPath(layout.root, path)}${truncated ? ` (truncated at ${formatBytes(READ_MAX_BYTES)} of ${formatBytes(totalBytes)})` : ''}`
        return `${header}\n${content}`
      }
      if (action === 'list') {
        const entries = await walk(layout.scratch)
        if (entries.length === 0) return `${displayPath(layout.root, layout.scratch)} is empty.`
        const lines = [`${displayPath(layout.root, layout.scratch)}:`]
        for (const entry of entries) {
          const relative = displayPath(layout.scratch, entry.path)
          if (entry.directory) {
            lines.push(`  ${relative}/`)
            continue
          }
          let size = 0
          try {
            size = (await stat(entry.path)).size
          } catch {
            /* a file may vanish between readdir and stat */
          }
          lines.push(`  ${relative} (${formatBytes(size)})`)
        }
        if (entries.length >= LIST_MAX_ENTRIES) lines.push(`(listing truncated at ${LIST_MAX_ENTRIES} entries)`)
        return lines.join('\n')
      }
      if (action === 'delete') {
        const path = resolveInside(layout.scratch, args?.path, 'path')
        if (path === layout.scratch) throw new Error('workspace-scratch: refusing to delete the session scratch directory itself')
        await rm(path, { recursive: true, force: true })
        return `deleted ${displayPath(layout.root, path)}`
      }
      throw new Error(`workspace-scratch: unknown action ${JSON.stringify(action)}; expected write, read, list or delete`)
    },
  })
}

/** Build the `memory` tool: durable notes under `.dsh/memory/`. */
function memoryTool(ctx, cfg) {
  return defineTool({
    name: 'memory',
    description: `Save, read, list, search and delete durable workspace notes stored in the workspace's memory directory (${cfg.dirName}/${cfg.memoryDirName}/). Notes survive across sessions and keep the workspace clean; ${MEMORY_INDEX} is maintained automatically as their index.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'read', 'list', 'search', 'delete'],
          description: 'save a note, read one, list the index, search every note, or delete one.',
        },
        name: { type: 'string', description: 'Note name; required for save, read and delete. The ".md" suffix is optional.' },
        content: { type: 'string', description: 'Markdown body of the note; required for save. The first heading or line becomes its index title.' },
        append: { type: 'boolean', description: 'Append to an existing note instead of replacing it (save only).' },
        query: { type: 'string', description: 'Case-insensitive text to look for in every note (search only).' },
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const layout = await toolLayout(ctx, cfg, exec)
      const action = args?.action
      const signal = exec?.signal
      if (action === 'save') {
        if (typeof args?.content !== 'string') throw new Error('workspace-scratch: content must be a string when action is "save"')
        const file = memoryFileName(args?.name)
        const path = join(layout.memory, file)
        await mkdir(layout.memory, { recursive: true, mode: 0o755 })
        if (args.append === true) {
          const separator = await stat(path)
            .then((info) => (info.size > 0 ? '\n' : ''))
            .catch(() => '')
          await appendFile(path, separator + args.content, { encoding: 'utf8' })
        } else {
          await writeFile(path, args.content, { encoding: 'utf8', mode: 0o644 })
        }
        await rebuildMemoryIndex(layout)
        signal?.throwIfAborted?.()
        return `${args.append === true ? 'appended to' : 'saved'} ${displayPath(layout.root, path)}; ${MEMORY_INDEX} updated.`
      }
      if (action === 'read') {
        const file = memoryFileName(args?.name)
        const path = join(layout.memory, file)
        const { content, truncated, totalBytes } = await readCapped(path)
        signal?.throwIfAborted?.()
        const header = `${displayPath(layout.root, path)}${truncated ? ` (truncated at ${formatBytes(READ_MAX_BYTES)} of ${formatBytes(totalBytes)})` : ''}`
        return `${header}\n${content}`
      }
      if (action === 'list') {
        try {
          return (await readCapped(join(layout.memory, MEMORY_INDEX))).content
        } catch {
          const notes = (await readdir(layout.memory, { withFileTypes: true }).catch(() => [])).filter(isNoteFile)
          return notes.length === 0 ? 'No memory notes yet.' : notes.map((entry) => entry.name).join('\n')
        }
      }
      if (action === 'search') {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query.length === 0) throw new Error('workspace-scratch: query must be a non-empty string when action is "search"')
        const needle = query.toLowerCase()
        const entries = await readdir(layout.memory, { withFileTypes: true }).catch(() => [])
        const files = entries.filter(isNoteFile).map((entry) => entry.name).sort()
        const hits = []
        for (const file of files) {
          let content = ''
          try {
            content = (await readCapped(join(layout.memory, file))).content
          } catch {
            continue
          }
          content.split(/\r?\n/).forEach((line, index) => {
            if (hits.length < 60 && line.toLowerCase().includes(needle)) hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 200)}`)
          })
        }
        if (hits.length === 0) return `No memory note matches ${JSON.stringify(query)}.`
        return [`Matches for ${JSON.stringify(query)}:`, ...hits].join('\n')
      }
      if (action === 'delete') {
        const file = memoryFileName(args?.name)
        const path = join(layout.memory, file)
        await rm(path, { force: true })
        await rebuildMemoryIndex(layout)
        signal?.throwIfAborted?.()
        return `deleted ${displayPath(layout.root, path)}; ${MEMORY_INDEX} updated.`
      }
      throw new Error(`workspace-scratch: unknown action ${JSON.stringify(action)}; expected save, read, list, search or delete`)
    },
  })
}

/**
 * Register the `.dsh` layout for every live and future agent, the prompt
 * guidance, both tools, and the settings page's HTTP API.
 *
 * The live config object `cfg` is mutated in place when the settings page
 * saves, because every prompt section and tool closes over that same object —
 * so a change applies to the next step without re-registering anything. The
 * tools are always registered and hidden per step through `when`, which is
 * what makes their toggles live too.
 *
 * @param ctx - owning plugin context.
 * @param rawConfig - the composition row's `config` block, validated here.
 */
export async function apply(ctx, rawConfig) {
  // Layer 2: the hand-edited row config. Layer 3 (`stored`) is read below.
  const rowLayer = validateLayer(rawConfig, 'config')
  let storedLayer = {}
  const loadWarnings = []
  try {
    storedLayer = await readSettings()
  } catch (error) {
    // A corrupt settings file must not stop the plugin: fall back to the row
    // config and surface the problem in the settings page instead.
    loadWarnings.push(error instanceof Error ? error.message : String(error))
  }

  /** The single object tools and prompts read; mutated in place on reload. */
  const cfg = composeConfig(rowLayer, storedLayer)

  /** Recompute the effective config from the current layers. */
  const reload = async () => {
    const stored = await readSettings()
    mirrorConfig(cfg, composeConfig(rowLayer, stored))
  }

  /** Create one agent's layout, logging instead of failing agent creation. */
  const prepare = async (agent) => {
    try {
      return await ensureLayout(ctx, cfg, agent)
    } catch (error) {
      warn(ctx, `could not prepare the .dsh layout for ${JSON.stringify(workspaceRootOf(ctx, agent))}: ${String(error)}`)
      return undefined
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    await prepare(agent)
  })
  for (const agent of ctx.agents.list()) await prepare(agent)

  ctx.systemPrompt.section({
    name: 'workspace-scratch:guidance',
    order: SECTION_ORDER,
    interpolate: false,
    text: () => (cfg.promptGuidance ? guidanceText(cfg, cfg.tools && (cfg.scratchTool || cfg.memoryTool)) : ''),
  })
  ctx.systemPrompt.context({
    name: 'workspace-scratch:paths',
    order: CONTEXT_ORDER,
    interpolate: false,
    text: (context) => (cfg.promptGuidance ? contextText(ctx, cfg, context.agent) : ''),
  })

  const toolsEnabled = () => cfg.tools === true
  ctx.tools.register(scratchTool(ctx, cfg), { when: () => toolsEnabled() && cfg.scratchTool === true })
  ctx.tools.register(memoryTool(ctx, cfg), { when: () => toolsEnabled() && cfg.memoryTool === true })

  // The webserver row activates after `webStartup` resolves, so the service is
  // absent at apply time. Register the routes once it appears.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (httpCtx) => {
      const webServer = httpCtx.get('webServer')
      if (!webServer) return
      const routes = createApiRoutes({
        // Reuse the GUI's own admission gate (`connection.requestRejection`),
        // so these routes are no easier to reach than the official /api/* ones.
        // Compositions without an auth service simply have no gate to apply.
        rejectRequest: (request) => {
          const connection = httpCtx.get('connection')
          if (connection === undefined) return undefined
          try {
            return connection.requestRejection(request)
          } catch {
            return 401
          }
        },
        effective: () => cfg,
        rowLayer: () => rowLayer,
        readStored: () => readSettings(),
        writeStored: (values) => writeSettings(values),
        clearStored: () => removeSettings(),
        settingsFile: () => settingsFile(),
        warnings: () => [...loadWarnings],
        reload,
      })
      for (const route of routes) httpCtx.effect(() => webServer.register(route), { label: `workspace-scratch: ${route.path}` })
    })
  }
}
