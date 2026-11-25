# dsh-workspace-scratch

一个 DeepSeek Harness（DSH）插件：让 **每次会话都在工作区根目录创建 `.dsh` 目录**，把临时文件和记忆文件都收进去，工作区本身不再被污染。

## 功能

会话开始（插件加载时已有的 agent、以及之后每个 `agent/created`）时，在工作区根目录建立：

```
<workspace>/.dsh/
├── .gitignore          # 内容为 `*`，保证 .dsh 里的东西不进版本库
├── tmp/
│   └── <session-id>/   # 本次会话的临时文件（脚本、中间产物、下载、日志、截图）
└── memory/             # 跨会话保留的记忆条目
    ├── MEMORY.md       # 自动维护的记忆索引
    └── *.md            # 每条记忆一个 markdown 文件
```

另外：

- 若工作区是 git 仓库，自动往 `.git/info/exclude` 追加 `/.dsh/`（不改动被跟踪的 `.gitignore`）。
- `tmp/<session-id>/` 超过 `retentionDays` 天未变动会在会话启动时自动清理（当前会话目录永远保留）。
- 注册 `scratch` 与 `memory` 两个模型工具，路径被强制限制在对应目录内，`../../` 之类越界路径直接报错。
- 注入一段系统提示词说明 + 一行运行时上下文（当前会话的 scratch / memory 绝对路径），让模型知道该往哪里写。

## 安装（已发布到 npm）

**插件已发布**：`dsh-workspace-scratch@0.2.1` → https://www.npmjs.com/package/dsh-workspace-scratch

### 通过官方 Discover 安装

在 DSH 里 **Plugins → Discover** 添加这个索引地址：

```
https://unpkg.com/dsh-workspace-scratch@0.2.1/plugin-index.json
```

然后搜索 `工作区` / `workspace` / `scratch`，点安装。

> 该地址已实测返回 200 且无重定向（Discover 拒绝重定向），索引也通过官方
> `@deepseek-ai/dsh-plugin-market-index` 校验。带版本号意味着**每次发新版要换 URL**；
> 建好 GitHub 仓库后可改用 `raw.githubusercontent.com` 的稳定地址。

### 直接安装

```bash
dsh plugin --profile <profile> install dsh-workspace-scratch@0.2.1
```

或在对话里：

```text
plugin_manager install_bundle target: "dsh-workspace-scratch@0.2.1"
```

## 本地开发安装

```bash
# 1. 装进当前 profile（desktop）。也可以直接用 GUI 的插件页安装/启用。
dsh plugin --profile desktop install ~/.dsh/plugins/dsh-workspace-scratch

# 2. 重启该 profile 生效
```

离线自测（不需要启动 DSH）：

```bash
cd ~/.dsh/plugins/dsh-workspace-scratch
node --test "test/**/*.test.mjs"
```

## 配置

下面这些字段可以直接写在 profile 的 `cordis.patch.yml`（行配置层）里；设置页写入的覆盖值优先级更高。
未写的字段取默认值：

```yaml
- id: workspace-scratch
  name: dsh-workspace-scratch
  config:
    dirName: .dsh           # 隐藏目录名，默认 .dsh
    tmpDirName: tmp         # 临时文件子目录，默认 tmp
    memoryDirName: memory   # 记忆子目录，默认 memory
    retentionDays: 7        # 会话临时目录保留天数，0 表示不清理
    writeGitIgnore: true    # 写 .dsh/.gitignore（内容 `*`）
    gitExclude: true        # 往 .git/info/exclude 追加 /.dsh/
    promptGuidance: true    # 注入系统提示词与运行时上下文
    tools: true             # 注册 scratch / memory 工具
    scratchTool: true       # 单独开关 scratch 工具
    memoryTool: true        # 单独开关 memory 工具
```

非法配置（如 `retentionDays: -1`、`dirName: "../x"`、非布尔开关）在加载期直接抛错，不会带病运行。

## 设置页（Settings → 工作区）

插件在设置面板注册一页「工作区」，可直接改这些字段，**保存后下一条消息即生效，无需重启**：

| 字段 | 作用 |
|---|---|
| `dirName` | 隐藏目录名（默认 `.dsh`） |
| `retentionDays` | 会话临时目录保留天数，`0` 表示永不清理 |
| `writeGitIgnore` | 是否写 `.dsh/.gitignore`（内容 `*`） |
| `gitExclude` | 是否往 `.git/info/exclude` 追加 `/.dsh/` |
| `tools` | `scratch` / `memory` 工具总开关 |
| `scratchTool` / `memoryTool` | 分别开关两个工具 |
| `promptGuidance` | 是否注入系统提示词与运行时上下文 |

配置是三层的浅合并，后者覆盖前者：

```
默认值  <  profile 里的行配置(config:)  <  设置页写入的覆盖值
```

设置页的覆盖值存在 **`$DSH_HOME/workspace-scratch/settings.json`**（默认 `~/.dsh/...`，权限 600），
不写进工作区。「恢复默认」会删除该文件，让字段回落到行配置与内置默认值。

界面上的按钮语义：

- **保存** —— 只提交改动过的字段，合并进已有覆盖值
- **恢复默认** —— 删除整个覆盖文件
- 页面顶部会显示设置文件路径、当前生效目录，以及是否有字段被界面覆盖

非法值（如负数天数、带 `/` 的目录名）由 host 校验后拒绝，错误原文显示在页面上，草稿不会丢失。

### 设置页 API

设置页通过插件自己的路由读写，**复用 GUI 的认证闸门**（`connection.requestRejection`），
与官方 `/api/*` 一样要求浏览器会话：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/workspace-scratch/api/state` | 返回三层配置、字段清单、设置文件路径与警告 |
| `POST` | `/workspace-scratch/api/config` | 合并保存覆盖值并热应用 |
| `POST` | `/workspace-scratch/api/reset` | 清空覆盖值；可传 `{keys:[...]}` 只清指定字段 |

未认证请求返回 401，跨源请求返回 403。

## 发新版（维护者）

包已发布，日常只需发新版本：

```bash
# 1. 改 package.json 的 version
# 2. 发布（prepublishOnly 会自动重建索引 + 跑全部测试）
npm publish
# 3. 更新索引 URL 里的版本号（README「安装」章节，以及告诉用户）
```

`prepublishOnly` 的顺序是 `build:index && test`，所以带过期索引或测试失败的包不会发出去。

发布需要 npm token 具备 **Bypass 2FA**；首包发布时 Packages 必须选 `All packages`
（包尚不存在时无法单独授权）。本机全局 registry 是 npmmirror 只读镜像，
所以 `publishConfig.registry` 已固定为 `registry.npmjs.org`。

### 索引与版本号

索引里的 `publishTimestamp` 每次重建都会更新，`version` 取自 `package.json`，
`engines.dsh` 取自 manifest。**索引 URL 目前带版本号**，发新版必须换 URL；
把 `plugin-index.json` 放进 GitHub 仓库并改用
`https://raw.githubusercontent.com/<你>/<repo>/main/plugin-index.json` 即可永久稳定。

### 免 npm 的替代路径：git 源

没有 npm 账号也能分发——索引支持 git 源，安装时固定到具体 commit：

```bash
node scripts/build-index.mjs --source git \
  --git-url https://github.com/<你>/dsh-workspace-scratch \
  --commit <40 位 commit SHA>
```

对应安装参数是 `git+https://github.com/...git#<commit>`。git 源的包必须在仓库根，
或在索引里用 `path` 指明子目录。

## 工具

### `scratch`

会话私有临时目录（`.dsh/tmp/<session>/`），`path` 相对该目录：

| action | 说明 |
|---|---|
| `write` | 写文件（自动建父目录）；`append: true` 追加 |
| `read` | 读文件，超过 64 KiB 截断并提示 |
| `list` | 递归列出临时目录，最多 200 项 |
| `delete` | 删除文件或子目录（拒绝删除会话目录本身） |

### `memory`

跨会话记忆（`.dsh/memory/`），每次保存后自动重建 `MEMORY.md` 索引：

| action | 说明 |
|---|---|
| `save` | 保存笔记，`name` 会规范成 `*.md` 文件名；`append: true` 追加 |
| `read` | 读某条笔记 |
| `list` | 输出记忆索引 |
| `search` | 在全部笔记里做大小写不敏感的行级搜索 |
| `delete` | 删除笔记并更新索引 |

## 模型体验

- **系统提示词段**：一段固定文字（`order` 1750），说明临时文件与记忆文件必须写进 `.dsh`，并给出目录约定。
- **运行时上下文行**：`Session scratch directory: "<...>". Workspace memory directory: "<...>".`（`order` 130）。路径随会话走，不写死在系统提示词里，因此不会破坏 prompt 前缀缓存。

## 安全性

- 所有路径先 `resolve` 再校验前缀，绝对路径和 `..` 越界都被拒绝。
- 会话根目录是文件系统根（如 `/`）时拒绝管理，避免把 `.dsh` 建到 `/` 下。
- 工作区根取会话记录的 `cwd`（原始项目目录），模型中途 `cd` 不会把 `.dsh` 挪到别处。
- 不做任何删除工作区文件的操作；`prune` 只清理 `.dsh/tmp/` 下过期的会话目录。

## 卸载

在 GUI 插件页停用/移除，或：

```bash
dsh plugin --profile desktop remove dsh-workspace-scratch
```

插件停用后 `.dsh` 目录仍留在工作区（数据是用户的），需要时手动删除即可。
