/**
 * dsh-workspace-scratch client half — the Settings page.
 *
 * Authored directly in the DSH client module format
 * (`window.__ModuleLoader__.load({ id, factory })`), the same delivery shape as
 * the official UI bundles: the host serves this file at
 * /plugins/dsh-workspace-scratch/client.js and the browser kernel loads it.
 * It talks to its own host half over /workspace-scratch/api/*, so it imports
 * nothing from `@deepseek-ai/*` beyond the baseline `react` module.
 *
 * Layout: a status line naming the effective settings file, then two groups —
 * 目录与清理 (where files go, how long they live) and 工具与提示词 (what the
 * model can use) — followed by Save / Reset. The page never decides validity
 * on its own: the host validates and returns the authoritative state, and its
 * error message is rendered verbatim.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-scratch',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Browser-only set of group ids the user collapsed. */
    const OPEN_KEY = 'dsh-workspace-scratch/settings-open'

    const css = `
.wss_page{display:flex;flex-direction:column;gap:16px;padding:0 4px 24px;font-size:13px}
.wss_head{display:flex;flex-direction:column;gap:4px}
.wss_title{font-weight:600;font-size:14px}
.wss_meta{font-size:12px;color:var(--dsw-alias-label-secondary,#888);word-break:break-all}
.wss_card{border:1px solid rgba(128,128,128,.3);border-radius:12px;overflow:hidden}
.wss_card_head{display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;background:transparent;border:0;color:inherit;font:inherit;cursor:pointer;text-align:left}
.wss_card_head:hover{background:rgba(128,128,128,.08)}
.wss_card_title{font-weight:600}
.wss_summary{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.wss_chevron{display:inline-block;width:12px;transition:transform .12s ease;color:var(--dsw-alias-label-secondary,#888)}
.wss_chevron.open{transform:rotate(90deg)}
.wss_body{display:flex;flex-direction:column;gap:14px;padding:4px 14px 16px}
.wss_row{display:flex;align-items:flex-start;gap:12px;justify-content:space-between}
.wss_row_text{display:flex;flex-direction:column;gap:2px;min-width:0}
.wss_label{font-weight:500}
.wss_hint{font-size:12px;color:var(--dsw-alias-label-secondary,#888);line-height:1.45}
.wss_key{font-size:11px;padding:0 4px;border-radius:4px;background:rgba(128,128,128,.16);color:var(--dsw-alias-label-secondary,#888);margin-left:6px}
.wss_control{flex:0 0 auto;display:flex;align-items:center;gap:6px}
.wss_input{font:inherit;font-size:13px;padding:5px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;width:110px;box-sizing:border-box}
.wss_input.wide{width:150px}
.wss_input.invalid{border-color:#c62828}
.wss_switch{position:relative;display:inline-flex;align-items:center;cursor:pointer}
.wss_switch input{position:absolute;opacity:0;width:0;height:0}
.wss_track{width:36px;height:20px;border-radius:10px;background:rgba(128,128,128,.45);transition:background .12s ease;display:inline-block;position:relative}
.wss_track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .12s ease}
.wss_switch input:checked + .wss_track{background:#1976d2}
.wss_switch input:checked + .wss_track::after{transform:translateX(16px)}
.wss_switch input:focus-visible + .wss_track{outline:2px solid #1976d2;outline-offset:2px}
.wss_switch input:disabled + .wss_track{opacity:.5}
.wss_footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:4px}
.wss_btn{cursor:pointer;font:inherit;font-size:12px;padding:6px 14px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit}
.wss_btn:hover:not(:disabled){background:rgba(128,128,128,.12)}
.wss_btn:disabled{opacity:.5;cursor:default}
.wss_btn.primary{border-color:transparent;background:#1976d2;color:#fff}
.wss_btn.primary:hover:not(:disabled){background:#1565c0}
.wss_dirty{font-size:12px;color:#ed6c02}
.wss_ok{font-size:12px;color:#2e7d32}
.wss_err{font-size:12px;color:#c62828;line-height:1.45}
.wss_warn{font-size:12px;color:#ed6c02;line-height:1.45;border:1px solid rgba(237,108,2,.4);border-radius:8px;padding:8px 10px}
.wss_note{font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
`

    /** Fetch JSON from the plugin's own host API. */
    async function api(path, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      const resp = await fetch(`/workspace-scratch/api/${path}`, init)
      const json = await resp.json().catch(() => ({ ok: false, message: `HTTP ${resp.status}` }))
      return { ok: resp.ok && json.ok !== false, status: resp.status, body: json }
    }

    /** Read the collapsed-group set, tolerating unavailable storage. */
    function readOpen() {
      try {
        const raw = window.localStorage.getItem(OPEN_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : null
      } catch {
        return null
      }
    }

    /** Persist the collapsed-group set. */
    function writeOpen(ids) {
      try {
        window.localStorage.setItem(OPEN_KEY, JSON.stringify(ids))
      } catch {
        /* private mode: collapse state simply does not persist */
      }
    }

    /** One labelled row with a control on the right. */
    function Row(props) {
      return h('div', { className: 'wss_row' },
        h('div', { className: 'wss_row_text' },
          h('span', { className: 'wss_label' },
            props.label,
            props.field === undefined ? null : h('code', { className: 'wss_key' }, props.field)),
          props.hint === undefined ? null : h('span', { className: 'wss_hint' }, props.hint)),
        h('div', { className: 'wss_control' }, props.children))
    }

    /** Theme-inheriting switch. */
    function Switch(props) {
      return h('label', { className: 'wss_switch' },
        h('input', { type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: (event) => props.onChange(event.target.checked) }),
        h('span', { className: 'wss_track', 'aria-hidden': 'true' }))
    }

    /** Collapsible card, one per group. */
    function Card(props) {
      return h('div', { className: 'wss_card' },
        h('button', {
          type: 'button',
          className: 'wss_card_head',
          onClick: props.onToggle,
          'aria-expanded': props.open,
        },
          h('span', { className: 'wss_chevron' + (props.open ? ' open' : ''), 'aria-hidden': 'true' }, '›'),
          h('span', { className: 'wss_card_title' }, props.title),
          h('span', { className: 'wss_summary' }, props.open ? '' : props.summary)),
        props.open ? h('div', { className: 'wss_body' }, props.children) : null)
    }

    /** Form value per field, derived from one effective-config snapshot. */
    function formOf(cfg) {
      return {
        dirName: cfg.dirName,
        retentionDays: String(cfg.retentionDays),
        writeGitIgnore: cfg.writeGitIgnore,
        gitExclude: cfg.gitExclude,
        promptGuidance: cfg.promptGuidance,
        tools: cfg.tools,
        scratchTool: cfg.scratchTool,
        memoryTool: cfg.memoryTool,
      }
    }

    /**
     * Exactly what Save posts. Kept as one function of `form` so the dirty
     * marker compares like-for-like with the request, and a field can never be
     * silently omitted from the payload while the panel reports success.
     */
    function payloadOf(form) {
      const days = form.retentionDays.trim()
      return {
        dirName: form.dirName,
        // A blank box leaves the stored value alone instead of sending 0,
        // which is a meaningful value for retentionDays.
        retentionDays: days === '' ? undefined : Number(days),
        writeGitIgnore: !!form.writeGitIgnore,
        gitExclude: !!form.gitExclude,
        promptGuidance: !!form.promptGuidance,
        tools: !!form.tools,
        scratchTool: !!form.scratchTool,
        memoryTool: !!form.memoryTool,
      }
    }

    /** Stable comparison form of a payload, so ordering cannot fake a change. */
    function canonical(payload) {
      const entries = Object.entries(payload).filter(([, value]) => value !== undefined)
      entries.sort((left, right) => (left[0] < right[0] ? -1 : 1))
      return JSON.stringify(entries)
    }

    /** The Settings page. */
    function WorkspaceScratchSection() {
      const [state, setState] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [saved, setSaved] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      const [open, setOpen] = React.useState(() => {
        const stored = readOpen()
        return Array.isArray(stored) && stored.length > 0 ? stored : ['paths', 'capabilities']
      })

      const accept = React.useCallback((body) => {
        setState(body)
        const next = formOf(body.effective)
        setForm(next)
        setSaved(next)
      }, [])

      React.useEffect(() => {
        let alive = true
        api('state').then((result) => {
          if (!alive) return
          if (result.ok) accept(result.body)
          else setLoadError(result.body?.message ?? `HTTP ${result.status}`)
        }).catch((error) => {
          if (alive) setLoadError(String(error))
        })
        return () => {
          alive = false
        }
      }, [accept])

      React.useEffect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-workspace-scratch', '')
        style.textContent = css
        document.head.appendChild(style)
        return () => style.remove()
      }, [])

      const toggleGroup = (id) => {
        const next = open.includes(id) ? open.filter((entry) => entry !== id) : [...open, id]
        setOpen(next)
        writeOpen(next)
      }

      if (loadError !== null) {
        return h('div', { className: 'wss_page' },
          h('div', { className: 'wss_head' },
            h('span', { className: 'wss_title' }, '工作区临时文件与记忆'),
            h('span', { className: 'wss_meta' }, '读取配置失败，插件可能未激活。')),
          h('div', { className: 'wss_err' }, loadError))
      }
      if (form === null) return h('div', { className: 'wss_page' }, h('span', { className: 'wss_meta' }, '加载中…'))

      const set = (key) => (event) => setForm({ ...form, [key]: event.target.value })
      const setBool = (key) => (value) => setForm({ ...form, [key]: value })
      const dirty = saved !== null && canonical(payloadOf(form)) !== canonical(payloadOf(saved))
      const toolCount = [form.scratchTool, form.memoryTool].filter(Boolean).length

      const save = async () => {
        setBusy('save')
        setMessage(null)
        const result = await api('config', payloadOf(form))
        setBusy('')
        if (result.ok) {
          accept(result.body)
          setMessage({ kind: 'ok', text: '已保存，下一条消息即按新设置生效。' })
        } else {
          // Keep the draft so nothing typed is lost; the host still holds the old value.
          setMessage({ kind: 'err', text: result.body?.message ?? `保存失败（HTTP ${result.status}）` })
        }
      }

      const reset = async () => {
        setBusy('reset')
        setMessage(null)
        const result = await api('reset', {})
        setBusy('')
        if (result.ok) {
          accept(result.body)
          setMessage({ kind: 'ok', text: '已恢复为默认/插件配置。' })
        } else {
          setMessage({ kind: 'err', text: result.body?.message ?? `重置失败（HTTP ${result.status}）` })
        }
      }

      const overridden = state === null ? [] : Object.keys(state.stored ?? {})
      const daysInvalid = form.retentionDays.trim() !== '' && !/^\d+$/.test(form.retentionDays.trim())

      return h('div', { className: 'wss_page' },
        h('div', { className: 'wss_head' },
          h('span', { className: 'wss_title' }, '工作区临时文件与记忆'),
          h('span', { className: 'wss_hint' }, '每次会话在工作区根目录建立隐藏目录，临时文件与记忆都放进去，工作区本身保持干净。'),
          h('span', { className: 'wss_meta' }, '设置文件：' + state.settingsFile),
          h('span', { className: 'wss_meta' }, '当前目录：' + state.effective.dirName + '/{' + state.effective.tmpDirName + '/<会话>, ' + state.effective.memoryDirName + '}')),

        (state.warnings ?? []).map((text, index) =>
          h('div', { className: 'wss_warn', key: 'warn' + index }, text)),

        h('div', { className: 'wss_note' },
          overridden.length === 0
            ? '全部字段来自插件配置（无界面覆盖）。'
            : `已覆盖：${overridden.join('、')}`),

        h(Card, {
          title: '目录与清理',
          summary: `保留 ${form.retentionDays || '?'} 天 · ${form.dirName}`,
          open: open.includes('paths'),
          onToggle: () => toggleGroup('paths'),
        },
          h(Row, {
            label: '隐藏目录名',
            field: 'dirName',
            hint: '会话在哪个子目录下工作；改名只影响之后新建的会话。',
          },
            h('input', { className: 'wss_input wide', value: form.dirName, spellCheck: false, onChange: set('dirName') })),

          h(Row, {
            label: '临时文件保留天数',
            field: 'retentionDays',
            hint: '超期未改动的会话临时目录会在下次会话启动时清理；0 表示永不清理。',
          },
            h('input', {
              className: 'wss_input' + (daysInvalid ? ' invalid' : ''),
              value: form.retentionDays,
              inputMode: 'numeric',
              onChange: set('retentionDays'),
              'aria-invalid': daysInvalid,
            })),

          h(Row, {
            label: '写 .gitignore',
            field: 'writeGitIgnore',
            hint: '在隐藏目录里放一个内容为 * 的 .gitignore，保证里面的文件不进版本库。',
          },
            h(Switch, { checked: form.writeGitIgnore, onChange: setBool('writeGitIgnore') })),

          h(Row, {
            label: '加入 .git/info/exclude',
            field: 'gitExclude',
            hint: 'git 仓库里额外把该目录加入本地排除清单，不改动被跟踪的 .gitignore。',
          },
            h(Switch, { checked: form.gitExclude, onChange: setBool('gitExclude') }))),

        h(Card, {
          title: '工具与提示词',
          summary: form.tools ? `${toolCount} 个工具${form.promptGuidance ? ' · 提示词开启' : ''}` : '工具已关闭',
          open: open.includes('capabilities'),
          onToggle: () => toggleGroup('capabilities'),
        },
          h(Row, {
            label: '注册 scratch / memory 工具',
            field: 'tools',
            hint: '总开关。关闭后模型无法直接读写这两个目录，但仍会创建目录。',
          },
            h(Switch, { checked: form.tools, onChange: setBool('tools') })),

          h(Row, {
            label: 'scratch 工具',
            field: 'scratchTool',
            hint: '按会话读写的临时文件目录（脚本、中间产物、日志、截图）。',
          },
            h(Switch, { checked: form.scratchTool, disabled: !form.tools, onChange: setBool('scratchTool') })),

          h(Row, {
            label: 'memory 工具',
            field: 'memoryTool',
            hint: '跨会话保留的记忆条目，自动维护 MEMORY.md 索引。',
          },
            h(Switch, { checked: form.memoryTool, disabled: !form.tools, onChange: setBool('memoryTool') })),

          h(Row, {
            label: '注入提示词指引',
            field: 'promptGuidance',
            hint: '告诉模型临时文件与记忆该往哪写，并在运行时上下文里给出本会话的绝对路径。',
          },
            h(Switch, { checked: form.promptGuidance, onChange: setBool('promptGuidance') }))),

        h('div', { className: 'wss_footer' },
          h('button', { className: 'wss_btn primary', onClick: save, disabled: busy !== '' || !dirty }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { className: 'wss_btn', onClick: reset, disabled: busy !== '' }, busy === 'reset' ? '重置中…' : '恢复默认'),
          dirty ? h('span', { className: 'wss_dirty' }, '● 有未保存的修改') : null,
          message === null ? null : h('span', { className: message.kind === 'ok' ? 'wss_ok' : 'wss_err' }, message.text)),

        h('div', { className: 'wss_note' },
          '目录名与保留天数改动只影响之后新建的会话；已有的隐藏目录不会自动迁移或删除。'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Park the registration on the plugin's fiber so unloading the plugin
        // removes the page instead of leaving a stale entry behind.
        const register = () => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'workspace-scratch',
          order: 55,
          label: '工作区',
        }, WorkspaceScratchSection))
        if (ctx.effect) ctx.effect(register)
        else register()
      },
    }
  },
})
