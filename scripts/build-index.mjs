#!/usr/bin/env node
/**
 * Build the DeepSeek Harness plugin-market index for this package.
 *
 * The index is what the official Discover tab (Plugins → Discover) reads: a
 * `format: 1` JSON document listing installable bundles. Users add its URL once
 * and can then search for and install this plugin like any other.
 *
 * Titles and descriptions come from `locale/*.json`, so the index and the
 * in-app plugin list can never disagree about what this plugin is called.
 *
 * Usage (npm source, the common case):
 *   node scripts/build-index.mjs --repository https://github.com/you/repo
 *
 * Usage (git source, for installing before an npm release exists):
 *   node scripts/build-index.mjs --source git \
 *     --git-url https://github.com/you/repo --commit <40-hex-sha>
 *
 * The output validates itself against @deepseek-ai/dsh-plugin-market-index when
 * that package is installed (it is a devDependency), so a broken index fails
 * here instead of in every user's Discover tab.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Parse `--key value` and `--flag` arguments. */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`)
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      index += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

/** Read one locale's `meta` block, keeping any language files present. */
async function localizedMeta(base) {
  const text = { title: {}, description: {} }
  for (const language of ['en', 'zh']) {
    let document
    try {
      document = JSON.parse(await readFile(`${ROOT}locale/${language}.json`, 'utf8'))
    } catch {
      continue
    }
    const meta = document.meta ?? {}
    if (typeof meta.title === 'string' && meta.title.length > 0) text.title[language] = meta.title
    if (typeof meta.description === 'string' && meta.description.length > 0) text.description[language] = meta.description
  }
  // The format requires an English title on every localized text.
  if (text.title.en === undefined) throw new Error('locale/en.json must define meta.title')
  return text
}

/** Inline the icon so the index needs no second request and no relative URL. */
async function inlineIcon() {
  const svg = await readFile(`${ROOT}icon.svg`)
  return `data:image/svg+xml;base64,${svg.toString('base64')}`
}

const manifest = JSON.parse(await readFile(`${ROOT}package.json`, 'utf8'))

/** The declared author, so `npm run build:index` needs no flags. */
function buildAuthor() {
  if (args.author !== undefined) return String(args.author)
  const declared = typeof manifest.author === 'string' ? manifest.author : undefined
  return declared === undefined || declared.trim() === '' ? undefined : declared.trim()
}
const meta = await localizedMeta()

const timestamp = args.timestamp === undefined
  ? Math.floor(Date.now() / 1000)
  : Number(args.timestamp)
if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp >= 1e11) {
  throw new Error(`--timestamp must be integer Unix seconds below 10^11, received ${JSON.stringify(args.timestamp)}`)
}

/** Build the `source` member, which decides how a user's install runs. */
function buildSource() {
  const kind = args.source ?? 'npm'
  if (kind === 'npm') {
    return {
      type: 'npm',
      ...args.registry === undefined ? {} : { registry: String(args.registry) },
    }
  }
  if (kind === 'git') {
    if (args['git-url'] === undefined) throw new Error('--source git requires --git-url')
    if (typeof args.commit !== 'string' || !/^[0-9a-f]{40}$/.test(args.commit)) {
      throw new Error('--source git requires --commit as a lowercase 40-hex commit SHA')
    }
    return {
      type: 'git',
      url: String(args['git-url']),
      commit: args.commit,
      ...args.path === undefined ? {} : { path: String(args.path) },
    }
  }
  throw new Error(`--source must be "npm" or "git", received ${JSON.stringify(kind)}`)
}

const plugins = [
  {
    name: manifest.name,
    title: meta.title,
    description: meta.description,
    icon: await inlineIcon(),
    ...buildAuthor() === undefined ? {} : { author: buildAuthor() },
    ...args.homepage === undefined ? {} : { homepage: String(args.homepage) },
    ...args.repository === undefined
      ? {}
      : {
          repository: {
            url: String(args.repository),
            ...args.directory === undefined ? {} : { directory: String(args.directory) },
          },
        },
    metadata: {
      category: 'workspace',
      keywords: [
        'workspace', '.dsh', 'scratch', 'temp files', 'memory', 'clean workspace',
        '工作区', '临时文件', '记忆',
      ],
      labels: [],
      sortKeys: {},
    },
    versions: [
      {
        version: manifest.version,
        publishTimestamp: timestamp,
        source: buildSource(),
        ...manifest.engines?.dsh === undefined ? {} : { engines: { dsh: manifest.engines.dsh } },
      },
    ],
  },
]

const index = {
  format: 1,
  title: {
    en: 'QwenWork DSH plugins',
    zh: 'QwenWork DSH 插件',
  },
  description: {
    en: 'Plugins published by QwenWork for DeepSeek Harness.',
    zh: 'QwenWork 发布给 DeepSeek Harness 使用的插件。',
  },
  metadata: {
    categories: {
      workspace: {
        title: { en: 'Workspace', zh: '工作区' },
      },
    },
  },
  plugins,
}

// Validate before writing: a malformed index is rejected by every client, and
// the rejection only shows up as an error in their Discover tab.
try {
  const { parseMarketIndex } = await import('@deepseek-ai/dsh-plugin-market-index')
  const base = String(args['index-url'] ?? 'https://example.invalid/plugin-index.json')
  parseMarketIndex(structuredClone(index), base)
  console.log(`index valid per @deepseek-ai/dsh-plugin-market-index (base ${base})`)
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    console.warn('warning: @deepseek-ai/dsh-plugin-market-index is not installed; wrote the index unvalidated')
  } else {
    throw error
  }
}

const out = String(args.out ?? `${ROOT}plugin-index.json`)
await writeFile(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`wrote ${out}`)
