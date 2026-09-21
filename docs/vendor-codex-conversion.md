# 内置 Codex 转换层（vendor/pi-codex-conversion）

`vendor/pi-codex-conversion/` 是 npm 包 `@howaboua/pi-codex-conversion` 的本地整包副本（上游版本
**3.0.34**，来自 monorepo `github.com/IgorWarzocha/howaboua-pi-stuff` 的 `packages/pi-codex-conversion`，
MIT）。纳入本仓库是为了让 patch 落在 metis-pi 的 git 里、不被 `pi update` 覆盖。pi 通过根
`package.json` 的 `pi.extensions` 条目 `./vendor/pi-codex-conversion/dist/index.js` 直接加载它；
该入口 default-export 一个扩展工厂，内部先注册 changelog，再调用 `registerCodexConversion`
（`src/extension/register.ts`，组合根）。上游自身约定见同目录 `UPSTREAM-AGENTS.md`、
`src/extension/AGENTS.md`、`CHANGELOG.md`。

## 提供的能力

**注册的工具**（`vendor:smoke` 在本机配置下观测到的 12 个注册项；名称/描述取自源码）：

| 工具 | 一句话职责 |
| --- | --- |
| `exec` | 用 JavaScript 组合其它工具（source only，无 JSON/fence）；Code Mode 入口 |
| `wait` | 恢复或终止一个 `exec` cell |
| `notebook` | 持久 notebook 状态：status/checkpoint/pin/prune/换 profile/restart/diagnostics/reset |
| `change_reasoning` | 按工作阶段（而非每次调用）调整 thinking effort，运行结束后回到用户起始级别 |
| `new_context` | 开一个新 context window（不动环境状态） |
| `get_context_remaining` | 返回当前 context window 的剩余 token |
| `history` | 跨 window 的历史检索（只能搜索、不给浏览） |
| `notes` | 虚拟路径上的跨 window checkpoint（含 cross-agent） |
| `apply_patch` | 应用 `*** Begin Patch / *** End Patch` 文本补丁 |
| `exec_command` | 跑 shell 命令，可能返回 `session_id` |
| `write_stdin` | 向该 session 写入/轮询（空轮询合法） |
| `view_image` | 查看图片（文本模型走 describe 回退） |

**此外提供的用户可见能力**：

- `/codex` 命令（`src/ui/settings/command.ts`）配置适配层；配置存 `pi-codex-conversion.json`。
- 两个 provider 注册：`src/providers/openai-codex-custom-provider.ts`（Codex/Responses 传输）与
  `src/providers/code-mode-proxy-provider.ts`；Code Mode / Notebook Mode 运行时，host 资产在
  `code-mode/vendor/code-mode-src`（Rust crates）。
- 上下文管理（compaction / context window / context tree）、TUI 渲染与工具改名（`src/ui/**`、
  `ui.toolRenaming`）、`apply_patch` 显示 broker、后台 shell widget、voice 渲染器与快捷键
  （`src/voice/**`、`src/ui/background-bash-widget.ts`）。

## 目录与产物

| 路径 | 作用 |
| --- | --- |
| `vendor/pi-codex-conversion/src/**` | 上游 321 个 `.ts`；**patch 打在这里**，不直接改 `dist/` |
| `vendor/pi-codex-conversion/dist/**` | `tsc -p tsconfig.build.json` 产物（642 个文件），**已提交**，pi 直接加载 |
| `vendor/pi-codex-conversion/changelog.ts` / `.js` | what's-new 载荷（状态在 `<agentDir>/howaboua-pi-stuff-changelog.json`）；`.js` 由 build 从 `.ts` 剥离类型生成，已提交。`CHANGELOG.md` 被 changelog 模块与宿主读取，缺失会打印启动警告 |
| `vendor/pi-codex-conversion/vendor/**` | 运行时资源：`tree-sitter-bash/`、`js-tiktoken/` |
| `vendor/pi-codex-conversion/code-mode/**` | code-mode host 资产与上游 notices |
| `vendor/pi-codex-conversion/src/tools/{exec,apply-patch,view-image}/bin/linux-x64/` | 原生工具二进制（仅 linux-x64） |
| `vendor/pi-codex-conversion/patches/local.patch` | 相对上游 `src/**` 的合并 diff（`npm run vendor:patch` 生成） |
| `vendor/pi-codex-conversion/UPSTREAM.md` | 出处、版本/commit、载荷范围、升级步骤 |
| `vendor/pi-codex-conversion/PATCHES.md` | 每条 patch 的现象/根因/修复/验证 |
| `scripts/vendor-codex-conversion.mjs` | `build` / `check` / `patch` / `sync` 四个动作 |
| `scripts/vendor-smoke.mjs` | 用 recording fake pi 激活 dist 入口的加载门禁 |
| `references/howaboua-pi-stuff/` | 纯净上游 checkout（gitignored，`patch`/`sync` 的基线，只读参考） |

`packageRoot()` 从 `dist/tools/native/binary.js` 上溯 4 层解析，所以 `dist/`、`vendor/`、
`code-mode/`、`src/tools/<tool>/bin/<platform>-<arch>/`、`changelog.js`、`package.json` 的位置不是自由布局。

## 构建、加载与门禁

`npm run vendor:build` 删除 `dist/`、用仓库内 TypeScript 跑 `tsc -p
vendor/pi-codex-conversion/tsconfig.build.json`，再把 `changelog.ts` 剥离类型写成 `changelog.js`。
产物**提交进 git**，因此安装期零构建：pi 直接执行 `dist/index.js`（源码态不可直接加载，`src/**`
用 NodeNext 的 `./x.js` 说明符，需要构建重写）。

| npm script | 动作 | 断言/产物 |
| --- | --- | --- |
| `vendor:build` | `scripts/vendor-codex-conversion.mjs build` | 重新生成 `dist/` + `changelog.js` |
| `vendor:check` | `tsc -p vendor/pi-codex-conversion/tsconfig.json --noEmit` | vendored 源码 0 type error |
| `vendor:patch` | diff vendored `src/` vs 上游（扣除裁剪载荷，重锚到 `src/`） | 重写 `patches/local.patch` |
| `vendor:sync` | 覆盖 vendored 树 → 重放 patch → 重建 | 上游升级；patch 冲突则 exit 1 |
| `vendor:smoke` | 激活 `dist/index.js`（fake pi） | 入口 default-export 是函数；注册了工具；含 `notebook`/`apply_patch`/`view_image`；**每个工具的 parameters 序列化为顶层 `type: "object"` 且无 `anyOf`** |
| `vendor:fresh` | `vendor:build` 后 `git diff --exit-code --stat -- dist changelog.js` | 防止"改了源码忘记重建" |

`npm run verify` 串起 `npm test`、`npm run check`、`vendor:check`、`vendor:smoke`、`test:host` 与
`npm pack --dry-run`。`build`/`check` 只依赖仓库内 TypeScript；`patch`/`sync`/`vendor:fresh` 依赖纯净
上游 checkout，缺失时打印提示并 exit 1。`vendor:sync` 只覆盖 `VENDORED_PATHS`（`src`、`vendor`、
`code-mode`、`types`、`changelog.ts`、`CHANGELOG.md`、`LICENSE`）；patch、`UPSTREAM.md`、`PATCHES.md`、
tsconfig 与 `package.json` 不被覆盖。

## 与上游的差异（patch 记账）

改动分三类，只有第一类进 `patches/local.patch`（`npm run vendor:patch` 只 diff `src/**`）：

1. **`src/` 源码 patch** — `PATCHES.md` 记账，`local.patch` 重放。当前只有一条：
   - `src/tools/code-mode/notebook-tool.ts` 的 `NOTEBOOK_PARAMETERS`：把顶层
     `Type.Union([...])`（5 个 object 变体）改成**单个 `Type.Object`**，`action` 的
     `StringEnum` 合并 12 个取值（status/list/checkpoint/restart/diagnostics/reset/save/load/
     pin/unpin/release/prune），`query`/`name`/`names` 变可选，保留
     `additionalProperties: false`。原因：严格 provider（DeepSeek 等）要求 function 参数的顶层
     schema 是 object，顶层 union 序列化后没有 `type`，整个请求被判 400
     `schema must be a JSON Schema of 'type: "object"', got 'type: null'`。执行期不对该 schema 做
     校验（`normalizeNotebookRequest` 处理参数），旧输入全部仍然合法。截至 3.0.34 未上报上游。
2. **构建配置适配**（不在 `local.patch` 内，`sync` 不覆盖，靠 `UPSTREAM.md` 记账）：
   `tsconfig.json` 改为 extends `./tsconfig.base.json`（上游是 monorepo 的 `../../tsconfig.base.json`），
   `tsconfig.base.json` 是上游 base 去掉 bun-only 的 `stableTypeOrdering`（TypeScript 5.9.3 不接受）。
3. **`package.json` 裁剪**：只留 identity/version/license/engines/dependencies/peerDependencies，
   置 `private: true`；运行时读它的 `name` + `version` 做 "npm 落后" 提示。

## 上游同步流程

1. 刷新纯净上游：`cd references/howaboua-pi-stuff && git fetch --depth 1 origin main && git checkout FETCH_HEAD`
2. `npm run vendor:sync` —— 覆盖 vendored 树、重放 `patches/local.patch`、重建 `dist/`；若 patch 不再
   干净应用会打印冲突并 exit 1，需手工调和后更新 `PATCHES.md`。
3. 跑门禁：`npm test`、`npm run check`、`npm run vendor:check`、`npm run test:pty`；用
   `npm run vendor:fresh` 确认提交产物可复现。
4. 更新 `UPSTREAM.md` 的版本/commit，并在仓库 `CHANGELOG.md` 记一条版本条目。
5. 新增/修改 patch：改 `src/**` → `npm run vendor:build && npm run vendor:patch && npm run
   vendor:check` → 在 `PATCHES.md` 补条目。**永远不要手改 `dist/**`**（`vendor:fresh` 会抓漂移）。

## 载荷裁剪与已知缺口

上游整包约 73 MB，其中 43 MB 是各平台语音 helper 二进制。本副本是 **11.7 MB 真实文件字节**：`dist/`
1.8 MB、`src/` 5.9 MB（含 linux-x64 原生工具 3.7 MB）、`vendor/` 3.5 MB、`code-mode/` 0.4 MB；裁剪由
`scripts/vendor-codex-conversion.mjs` 的 `EXCLUDES` 两条正则实现：

- `src/voice/bin/**`（语音 helper）被剔除 → **语音功能在使用时报错**（加载不受影响）。
- `src/tools/{exec,apply-patch,view-image}/bin/` 只保留 `linux-x64` → 其它平台缺原生二进制；换平台需
  放宽 `EXCLUDES` 后重跑 `sync`。

其它已知行为/缺口（细节见 `UPSTREAM.md`）：

- 副本不在 `node_modules` 下，上游的本地 checkout 逻辑会拿 `package.json` 版本与 npm 已发布版本比较，
  在 npm 更新时打印 "落后" 警告；把它当作上游已移动的信号，走上面的同步流程。
- 默认 `backgroundShellPrevShortcut = alt+q` 与 pi 内置 `app.message.dequeue` 冲突，pi 会显示
  "Extension issues" banner；真实安装应在 `pi-codex-conversion.json` 覆盖（本机用
  `ui.backgroundShellPrevShortcut = "alt+u"`）。vendored 默认值刻意保留不改。
- 本包自带该转换层后必须卸载/禁用 npm 上的同名包，否则两套工具同名注册。
- 上游 pin（引自 `UPSTREAM.md`）：版本 **3.0.34**，commit `b4e228e049b7934a4350a9d9f14eaba6f9f59796`
  （2026-09-18，"Version Packages (#414)"），MIT。

## 代码位置

| 关注点 | 路径 / 锚点 |
| --- | --- |
| pi 入口（manifest）与扩展工厂 | `package.json` → `pi.extensions`；`vendor/pi-codex-conversion/dist/index.js`（源 `src/index.ts`） |
| 注册组合根 / 运行时 / 事件 | `src/extension/register.ts`（`registerCodexConversion`）、`src/extension/runtime.ts`、`src/extension/events.ts` |
| 工具注册 | `src/extension/tools.ts` — `registerCodexTools` |
| `exec`/`wait`/`notebook` | `src/tools/code-mode/public-tools.ts`、`src/tools/code-mode/notebook-tool.ts` |
| `exec_command`/`write_stdin` | `src/tools/exec/command-tool.ts`、`src/tools/exec/write-stdin-tool.ts` |
| `apply_patch`（含显示 broker） | `src/tools/apply-patch/tool.ts`、`src/tools/apply-patch/display-broker.ts` |
| `view_image` | `src/tools/view-image/tool.ts` |
| `change_reasoning` | `src/adapter/auto-reasoning.ts` |
| `new_context`/`get_context_remaining`/`history`/`notes` | `src/context-management/tools.ts`、`src/context-management/history-notes.ts` |
| provider 与 `/codex` 命令 | `src/providers/openai-codex-custom-provider.ts`、`src/providers/code-mode-proxy-provider.ts`、`src/ui/settings/command.ts`（配置默认值在 `src/adapter/activation/config-contract.ts`） |
| 原生二进制定位 | `src/tools/native/binary.ts` — `packageRoot()` |
| 本地 patch（唯一） | `src/tools/code-mode/notebook-tool.ts` — `NOTEBOOK_PARAMETERS`；`patches/local.patch` |
| 构建/同步工具 | `scripts/vendor-codex-conversion.mjs`、`scripts/vendor-smoke.mjs` |
| vendored 自述 | `UPSTREAM.md`、`PATCHES.md`、`UPSTREAM-AGENTS.md`、`src/extension/AGENTS.md`、`CHANGELOG.md` |
