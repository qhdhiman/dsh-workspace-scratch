/**
 * Configuration layers and the settings page's HTTP API for
 * dsh-workspace-scratch.
 *
 * Effective config is the shallow merge of three layers, later winning:
 *   1. `DEFAULT_CONFIG` — hard-coded defaults.
 *   2. the composition row's `config:` block (hand-edited, reviewable).
 *   3. the settings file written by the GUI page (this module owns it).
 *
 * The settings file lives in the harness home, never in the workspace, and is
 * written atomically so a crash cannot leave a half-written document.
 *
 * Imports nothing from `@deepseek-ai/*`: a `link:`-ed package resolves its
 * imports from its own real directory, where DSH packages are not installed.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Defaults for every supported config field. */
export const DEFAULT_CONFIG = {
  /** Workspace-relative name of the hidden directory this plugin owns. */
  dirName: '.dsh',
  /** Subdirectory holding per-session scratch files. */
  tmpDirName: 'tmp',
  /** Subdirectory holding durable memory notes. */
  memoryDirName: 'memory',
  /** Days a session scratch directory survives without being touched. */
  retentionDays: 7,
  /** Write `<dir>/.gitignore` so git never reports the directory's contents. */
  writeGitIgnore: true,
  /** Append `/<dir>/` to `.git/info/exclude` in git workspaces. */
  gitExclude: true,
  /** Register the system-prompt guidance section and runtime context. */
  promptGuidance: true,
  /** Register the `scratch` and `memory` tools. */
  tools: true,
  /** Register the `scratch` tool. */
  scratchTool: true,
  /** Register the `memory` tool. */
  memoryTool: true,
}

/** Fields the settings page may change, in display order. */
export const EDITABLE_FIELDS = Object.keys(DEFAULT_CONFIG)

const SEGMENT = (value) => typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !/[\\/]/.test(value)
const FLAG = (value) => typeof value === 'boolean'

/** Per-field validators, mirroring the shape each default declares. */
const FIELDS = {
  dirName: { check: SEGMENT, expectation: 'a single path segment' },
  tmpDirName: { check: SEGMENT, expectation: 'a single path segment' },
  memoryDirName: { check: SEGMENT, expectation: 'a single path segment' },
  retentionDays: { check: (value) => Number.isInteger(value) && value >= 0 && value <= 3650, expectation: 'an integer between 0 and 3650' },
  writeGitIgnore: { check: FLAG, expectation: 'a boolean' },
  gitExclude: { check: FLAG, expectation: 'a boolean' },
  promptGuidance: { check: FLAG, expectation: 'a boolean' },
  tools: { check: FLAG, expectation: 'a boolean' },
  scratchTool: { check: FLAG, expectation: 'a boolean' },
  memoryTool: { check: FLAG, expectation: 'a boolean' },
}

/**
 * Keep only the keys a layer actually sets, each validated.
 * @param raw - an untrusted layer: a row config or a settings file.
 * @param label - layer name used in error messages.
 * @returns the accepted, validated subset.
 * @throws for a non-object layer or an unusable value.
 */
export function validateLayer(raw, label = 'config') {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`workspace-scratch: ${label} must be an object`)
  const accepted = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const field = FIELDS[key]
    if (field === undefined) throw new Error(`workspace-scratch: ${label}.${key} is not a supported field`)
    if (!field.check(value)) {
      throw new Error(`workspace-scratch: ${label}.${key} must be ${field.expectation}, received ${JSON.stringify(value)}`)
    }
    accepted[key] = value
  }
  return accepted
}

/** The harness home: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

/** Absolute path of the settings file the GUI page writes. */
export function settingsFile() {
  return join(dshHome(), 'workspace-scratch', 'settings.json')
}

/**
 * Read the stored settings layer.
 * @param path - settings file path.
 * @returns the accepted overrides; `{}` when the file is absent.
 * @throws when the file exists but is not a JSON object of usable values.
 */
export async function readSettings(path = settingsFile()) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workspace-scratch: settings file ${JSON.stringify(path)} is not valid JSON; delete it to start over`)
  }
  return validateLayer(parsed, 'settings')
}

/**
 * Replace the stored settings layer atomically.
 * @param values - the complete override set to persist.
 * @param path - settings file path.
 * @returns the persisted values.
 */
export async function writeSettings(values, path = settingsFile()) {
  const validated = validateLayer(values, 'settings')
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  const staging = `${path}.${process.pid}.tmp`
  await writeFile(staging, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(staging, path)
  return validated
}

/** Delete the settings file so every field falls back to the row config. */
export async function removeSettings(path = settingsFile()) {
  await rm(path, { force: true })
}

/**
 * Compose one effective config object from the three layers.
 * @param layers - row and stored layers, later winning over earlier.
 * @returns a fresh plain object carrying every field.
 */
export function composeConfig(...layers) {
  return Object.assign({}, DEFAULT_CONFIG, ...layers.map((layer) => validateLayer(layer)))
}

/**
 * Copy a new effective config onto the live object tools and prompts close
 * over, so a settings change takes effect without re-registering anything.
 * @param target - the live config object.
 * @param next - the composed config to mirror.
 */
export function applyConfig(target, next) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(next, key)) delete target[key]
  Object.assign(target, next)
}

/** Write one JSON response with no caching. */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Read a JSON request body, bounded so a malformed client cannot exhaust memory. */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`workspace-scratch: request body exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('workspace-scratch: request body must be a JSON object')
  return parsed
}

/**
 * Build the settings page's routes.
 * @param options - live accessors owned by the plugin.
 * @returns exact-path routes ready for `webServer.register`.
 */
export function createApiRoutes(options) {
  /**
   * Read the stored layer without letting a damaged file break the page: a
   * corrupt document must stay visible and repairable from the settings UI
   * (saving or resetting rewrites it), not answer 500.
   * @returns the accepted overrides and any problem worth showing.
   */
  const safeStored = async () => {
    try {
      return { values: await options.readStored(), problem: undefined }
    } catch (error) {
      return { values: {}, problem: error instanceof Error ? error.message : String(error) }
    }
  }

  const state = async () => {
    const { values: stored, problem } = await safeStored()
    const warnings = [...options.warnings()]
    if (problem !== undefined && !warnings.includes(problem)) warnings.push(problem)
    return {
      ok: true,
      effective: { ...options.effective() },
      defaults: { ...DEFAULT_CONFIG },
      row: { ...options.rowLayer() },
      stored: { ...stored },
      fields: EDITABLE_FIELDS,
      settingsFile: options.settingsFile(),
      warnings,
    }
  }

  const update = async (req, res) => {
    try {
      const patch = await readJsonBody(req)
      const { values: stored } = await safeStored()
      const nextStored = validateLayer({ ...stored, ...patch }, 'settings')
      await options.writeStored(nextStored)
      await options.reload()
      sendJson(res, 200, await state())
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  const reset = async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const keys = Array.isArray(body.keys) ? body.keys : undefined
      if (keys === undefined) {
        await options.clearStored()
      } else {
        const { values: stored } = await safeStored()
        const nextStored = { ...stored }
        for (const key of keys) {
          if (typeof key !== 'string') throw new Error('workspace-scratch: keys must be field names')
          delete nextStored[key]
        }
        await options.writeStored(nextStored)
      }
      await options.reload()
      sendJson(res, 200, await state())
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Answer GET as state and POST as a write; other methods get 405.
   *
   * Each request first passes the GUI's own admission gate. Routes registered
   * straight on the webserver are otherwise reachable without the browser
   * session the official `/api/*` routes require, which would let any local
   * process read and rewrite these settings.
   */
  const route = (path, onGet, onPost) => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const rejection = options.rejectRequest?.(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(rejection === 401 ? 'dsh web authentication required; reopen the URL printed by dsh web.\n' : 'forbidden\n')
        return
      }
      const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET'
      if (method === 'GET' || method === 'HEAD') {
        try {
          sendJson(res, 200, await onGet())
        } catch (error) {
          sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (method === 'POST') {
        await onPost(req, res)
        return
      }
      res.setHeader('Allow', 'GET, HEAD, POST')
      sendJson(res, 405, { ok: false, message: `workspace-scratch: ${method} is not allowed here` })
    },
  })

  return [
    route('/workspace-scratch/api/state', state, update),
    route('/workspace-scratch/api/config', state, update),
    route('/workspace-scratch/api/reset', state, reset),
  ]
}
