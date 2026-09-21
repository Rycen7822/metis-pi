# 开发与验证

> 怎么跑、跑什么、提交前必须过哪些门禁，以及改这个仓库时的约定。

## 环境

| 要求 | 说明 |
| --- | --- |
| Node.js >= 22.19.0 | 测试用 `--experimental-strip-types` 直接跑 `.ts`，不预编译 |
| tmux | 仅 `npm run test:pty` 需要；**缺失时该脚本跳过并以 0 退出** |
| pi（或 `PI_BIN`） | 仅 pty 验证需要：它启动真实 pi 二进制 |

```bash
npm install --ignore-scripts --no-audit --no-fund
```

## 装到 pi 里

```bash
pi install /绝对路径/metis-pi      # 本目录
# 或从 git / npm 源安装（见 pi 的 packages 文档）
```

重启 pi 后紧凑转录**默认生效**，无需另开 optional 扩展。主题在 `/settings` 里选 `metis-pi`（或直接写 `~/.pi/agent/settings.json` 的 `"theme"` 字段）。

> **注意**：以 git 源安装时，pi 只装**生产依赖**（不装 devDependencies）。因此 `npm test` 在安装副本里会有若干条因缺 `@earendil-works/*` 而失败的用例——那是环境造成，不是回归；完整套件必须在开发检出里跑。

## 门禁脚本

| 命令 | 检查什么 | 何时跑 |
| --- | --- | --- |
| `npm test` | 全部单元/集成测试（`test/*.test.mjs` + `*.test.mts`） | 每次改动 |
| `npm run check` | `tsc` 全量类型检查（含 `extensions/**`，需 devDeps 提供宿主类型） | 每次改动 |
| `npm run check:core` | 只查 `src/**/*.ts`（`tsconfig.core.json`） | 不装宿主依赖时 |
| `npm run test:chrome` | 只用 `test/chrome.test.mjs`：**真实宿主数据形状**的 chrome 级测试 | 改 chrome/常驻界面时 |
| `npm run test:host` | `scripts/host-smoke.mjs`：用**真实** pi 组件跑（绝不用 mock 替代依赖） | 改宿主适配时 |
| `npm run test:pty` | `scripts/pty-verify.mjs`：真实 tmux PTY + **本地 mock OpenAI 兼容 provider**（零付费请求），用 `tmux capture-pane` 拿真实屏幕帧 | 改可见行为后（最有力的证据） |
| `npm run verify` | `test && check && vendor:check && vendor:smoke && test:host && npm pack --dry-run` | **提交前跑这个** |
| `npm run preview` | 用生产两槽渲染器生成 `docs/preview.html`、`docs/transcript.ansi`、`docs/transcript.txt` | 改渲染外观后 |
| `node scripts/copy-perf.mjs` | 选区复制的性能测量（含覆盖表） | 改复制路径后 |

`scripts/pty-verify.mjs` 是这个仓库最有价值的一件工具：它逐条断言**真实屏幕上的行为**（思考窥视窗、skill 合流折叠、todo 面板、选区复制逐字、footer 数字、留白、字形），而不是断言内部状态。改动任何"用户看得见"的东西，都应该让它继续 PASS。

## vendor 工作流（内置 Codex 转换层）

```bash
npm run vendor:check    # 类型检查上游源码（vendored 源码必须能编译）
npm run vendor:smoke    # 用假 pi 激活 vendored 入口，断言工具注册与参数形状
npm run vendor:fresh    # 重建 dist 后必须无 diff（防止"改了源码忘记重建"）
npm run vendor:sync     # 升级上游：拷新源码 → 重放 patches/local.patch → 重建 dist
npm run vendor:patch    # 重新生成 patches/local.patch（相对上游的合并 diff）
npm run vendor:build    # 只重建 dist
```

细节与 patch 记账见 [vendor-codex-conversion.md](vendor-codex-conversion.md)。

## 测试布局

| 文件 | 覆盖 |
| --- | --- |
| `test/helpers.mjs` | 共享夹具（含只读的真实形状 ctx 构造器） |
| `test/chrome.test.mjs` | chrome 级：真实宿主字段形状 + `src/chrome` 不得 import 宿主包的目录规则 |
| `test/host-surface.test.mjs` | 真实宿主组件下的 surface/行为 |
| `test/transcript.test.mts` | 转录状态与协调（最大的一份） |
| `test/todo-*.test.mts` | todo 子系统（model/store/tools/widget/extension 分层） |
| `test/skill-*.test.mts` | 令牌解析、展开、两个显示补丁 |
| `test/golden.layout.test.mjs`、`shell.golden.test.mjs` | 布局金样 |
| `test/package.test.mjs` | 边界与清单（见 [architecture.md](architecture.md) §由测试强制的边界） |

测试纪律（写在这个仓库的历史里，值得保留）：**禁止用只镜像"插件自己假设"的假接口**——0.8.3 曾因此发布过一个空 footer。要么用真实宿主形状，要么用真实组件。

## 文档维护

| 改动类型 | 写哪里 |
| --- | --- |
| 新增/改变**功能行为** | `docs/features/<feature>.md` + 在 [docs/README.md](README.md) 的两张表里登记 |
| 新增配置键 | [configuration.md](configuration.md)（含默认值/范围/回退语义） |
| 新增命令/工具/手势/路径 | [commands.md](commands.md) |
| 结构、边界、模块职责变化 | [architecture.md](architecture.md) |
| 版本修复与证据 | `VALIDATION.md`（`Findings` / `Fix` / `Reproduction and verification`） |
| 版本差异摘要 | `CHANGELOG.md` |

约定：**不写行号**（用文件 + 符号名）；限制要写全（每页都有"不变量与已知限制"）；本目录只写**当前真相**，历史留在 `VALIDATION.md` 与那三份旧计划里。

## 代码约定

1. **显示层边界**：`src/**`（除 `src/todo/`）不注册工具、不改写结果与上下文、不监听 `tool_call`/`tool_result`/`context`/`before_agent_start`；唯一允许持久化的模块是 `src/turn-summary.ts`。这些由 `test/package.test.mjs` 强制。
2. **`src/chrome/**` 不 import 宿主包**（由 `test/chrome.test.mjs` 遍历目录强制）。全仓唯一的 `src/` 宿主 import 在 `src/skill-mux.ts`（它需要宿主的 `loadSkills`/`stripFrontmatter` 与补全类型）。
3. **退避优先于猜测**：宿主接口形状不认识就整块退避，并给出可诊断的原因（`/codex-ui` 能看到）。
4. **不新增仅测试用的导出**：测试要缝就用真实现；已有的白盒钩子（`renderShellRow`、`thinkingRunPlans` 等）保留。
5. **先量后改**：性能/视觉改动在 `VALIDATION.md` 里记录测量方法与结果（这个仓库的传统是"measured, not assumed"）。
6. 2 空格缩进、双引号、ESM、import 路径带显式 `.ts` 扩展名；`extensions/goal.ts` 例外（vendored，保持制表符缩进便于与上游对照）。

## 提交前检查清单

```bash
npm run verify        # 测试 + tsc + vendor 门禁 + 宿主 smoke + pack dry-run
npm run test:pty      # 有 tmux 时必跑（可见行为改动的唯一可信证据）
npm run preview       # 若改了渲染外观，顺带更新 docs/preview.*
```

再加上：功能文档是否更新、`CHANGELOG.md`/`VALIDATION.md` 是否补记录、版本号是否要动（`package.json`）。

## 发布

`scripts/publish-github.sh` 是**显式**的本地回退：它创建一个**新的私有**仓库并推送已审阅的文件；不索取也不内嵌任何 token，使用调用者已有的 `gh` 认证。常规发布走 npm 包与 git 源（`pi install`）。
