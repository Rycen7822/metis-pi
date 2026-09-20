# 架构与模块地图

> 仓库如何被 pi 加载、`src/**` 每个模块负责什么、数据怎么流、哪些边界由测试强制、改代码该动哪里。

## 加载模型

`package.json` 的 `pi` 块是唯一入口声明：

```jsonc
"pi": {
  "extensions": ["./extensions/*.ts", "./vendor/pi-codex-conversion/dist/index.js"],
  "themes": ["./themes/codex-appearance.json"]
}
```

| 入口 | 性质 | 注册什么 |
| --- | --- | --- |
| `extensions/appearance.ts` | **显示层**（本主题的入口，原 `index.ts`） | 不注册任何工具/命令；只装饰渲染 |
| `extensions/skill-mux.ts` | 显示层补丁 | 输入展开与补全触发 |
| `extensions/skill-entry.ts` | 显示层补丁 | 折叠条目点击 + 多 skill 名字 |
| `extensions/todo.ts` | **非显示层** | `todo` 工具、`/todos`、`/todos-doctor`、面板 widget |
| `extensions/goal.ts` | **非显示层（vendored）** | `/goal`、三个 goal 工具、会话/上下文钩子 |
| `vendor/pi-codex-conversion/dist/index.js` | **非显示层（vendored）** | Codex 工具层（见 [vendor-codex-conversion.md](vendor-codex-conversion.md)） |

用户可在 `~/.pi/agent/settings.json` 里按包过滤入口（`-` 前缀 = 强制排除），例如 `["-goal.ts"]`。

## 顶层目录

| 路径 | 作用 |
| --- | --- |
| `src/` | 显示层运行时的全部实现（下节有模块地图） |
| `extensions/` | manifest 暴露的入口文件（薄接线层） |
| `vendor/pi-codex-conversion/` | 内置 Codex 转换层（源码 + 提交进 git 的 `dist/` + patch 记账） |
| `test/` | 单元/集成/宿主形状测试（`*.test.mjs` / `*.test.mts`） |
| `scripts/` | 预览、真实 PTY 验证、宿主 smoke、vendor 工具、性能测量、发布脚本 |
| `themes/codex-appearance.json` | 配套主题 |
| `docs/` | **本手册** + 旧实施计划 + `preview.*` 生成物 |
| `VALIDATION.md` | 逐版本验证记录（证据，不是功能文档） |
| `CHANGELOG.md` | 版本差异 |
| `NOTICE` / `LICENSE-APACHE-2.0` | vendored 代码的归属与许可 |

## `src/` 分层与模块地图

### 装配与宿主桥接

| 模块 | 职责 |
| --- | --- |
| `extension.ts` | 显示入口的 `activate`：读配置、绑定宿主 `ctx`、装 adapter、装 chrome、接事件（会话/交互/工具/额度/git 刷新） |
| `host-data.ts` | **窄而显式的宿主桥**：把真实 `ExtensionContext` 收敛成少量 getter（`ui`、`mode`、`isTui`、`hasUI`、`available`、model/cwd/thinking、usage、revision） |
| `adapter.ts` | 装饰宿主 `ToolExecutionComponent`（4 个方法 + 源码校验 + 身份还原） |
| `config.ts` | 配置类型、默认值、校验（渲染路径永不读文件） |

### 转录显示

| 模块 | 职责 |
| --- | --- |
| `tool-names.ts` | 共享的显示类型与内建工具名集合（`Component` 等结构类型） |
| `renderers.ts` | 两个渲染槽（call = 标题/头、result = 正文）的装配与注册 |
| `shell.ts` | 命令执行行的**物理行**模型排版（wrap / 行预算 / 中间截断 / 宽度感知） |
| `diff.ts` | **唯一**的 Codex 风格 diff 渲染器（结构化行 → gutter + 符号 + 整行底色） |
| `diff-component.ts` | 结构化行 → diff 组件的单一运行时路径（写与编辑共用） |
| `explore.ts` | `• Explored` 探索行（动词着色、查询/路径分离） |
| `bash-lexer.ts` | 词法状态感知的 bash 高亮（语法归属上游） |
| `palette.ts` | Catppuccin Mocha 调色板 + 颜色等级解析 + 降级；`CODEX_CYAN` 唯一来源 |
| `output-style.ts` | 工具输出的 SGR 状态机（Codex `Modifier::DIM` 语义） |
| `write-preview.ts` | 流式 write 预览（结构化标题 + 物理行尾部预算） |
| `write-tracker.ts` | 内建 `write` 的 pre/post image 校验（仅进程内存） |
| `glyph-presentation.ts` | 字形文字呈现（渲染前最后一跳补 U+FE0E） |

### 转录状态与协调

| 模块 | 职责 |
| --- | --- |
| `transcript-state.ts` | 显示序投影 + **唯一的 run 归并**（`semanticRuns` / `renderedThinkingRuns`） |
| `transcript-adapter.ts` | 一层助手装饰：把宿主重建后的子组件与语义 run 对齐（含思考计时/折叠/标签） |
| `thinking-view.ts` | 思考块形态状态机（折叠/窥视/全展开 + 手势与延迟逻辑） |
| `thinking-summary.ts` | 折叠标签文本（`Thought for 13s`） |
| `interaction-outcome.ts` | 终止证据判定（`Worked`/`Failed`/`Interrupted`/`Ended`） |
| `turn-summary.ts` | 结束摘要（**唯一**被允许 `appendEntry` 的模块） |

### 常驻 chrome（`src/chrome/`）

| 模块 | 职责 |
| --- | --- |
| `install.ts` | **chrome 生命周期**：状态、安装（`install`）、失效（`invalidate`）、还原（`restore`）、Working 可见性；自己负责 5 个 chrome 模块的预加载 |
| `editor.ts` | Codex 外观的 composer 工厂（继承宿主 `CustomEditor`；`> ` 前缀、占位符、`skillTrigger`） |
| `transcript-components.ts` | 转录区显示组件类（分隔线、write 调用、思考 rail/窥视窗/可点击） |
| `footer.ts` | 底部状态行布局与优先级降级 |
| `header.ts` | 启动身份行（真实版本号） |
| `working.ts` | Working 行（相位、细节、彗尾动画、两个定时器） |
| `composer-metadata.ts` | 编辑区下方 metadata 行 |
| `snapshots.ts` | chrome 用的显示数据快照（一帧一份，带 revision） |
| `fullscreen-margin.ts` | fullscreen 侧边留白 |
| `history-window.ts` | 有界历史窗口（5000 行预算、按需换页、选区冻结） |

### 共享度量与派生数据

| 模块 | 职责 |
| --- | --- |
| `ui-metrics.ts` | 单一交互时钟（`agent_start` → `agent_settled`）+ 时长格式化 |
| `usage-ledger.ts` | session 累计 usage（`Σ`；三个范围不混用） |
| `output-speed.ts` | 观测输出速度（`tok/s`） |
| `git-changes.ts` | 会话 churn 计数（只读 git，临时对象库比较内容） |
| `segments.ts` | 共享分段排版原语（`Segment`、`formatCount`、`clipLine`、窄屏降级） |

### 子系统

| 目录/模块 | 职责 |
| --- | --- |
| `selection-copy/**` | 逻辑选区复制（`index` 系统与路由、`serialize` 选区→文本、`markdown` 溯源适配、`structure` 布局级溯源、`model` copy product、`parser` 词法、`wrap` 软折行复刻与 `stripAnsi`） |
| `quota/**` | Codex 额度（`codex-app-server` 查询、`normalize-codex` 归一化、`quota-store` 编排、`types`） |
| `todo/**` | 任务子系统（`model` 纯函数、`store` 磁盘与锁、`tools` 模型侧工具、`widget` 面板、`commands` 命令） |
| `skill-tokens.ts` / `skill-mux.ts` / `skill-fold.ts` / `skill-label.ts` | 多 skill 令牌解析、输入展开、两个显示补丁 + 共享的 `patchHostPrototype` 守卫 |
| `diagnostics.ts` | `/codex-ui` 注册与逐行状态报告 |

## 三条数据流

**1. 工具行（转录区）**

```
宿主 ToolExecutionComponent  ──(原型包装，源码校验)──▶ adapter.ts
   ├─ getCallRenderer  → renderers.ts 的 renderCall（标题/头）
   └─ getResultRenderer→ renderers.ts 的 renderResult（正文）
                              ├─ shell.ts   （命令执行行）
                              ├─ diff.ts    （编辑/写入的整行 diff）
                              └─ explore.ts （探索分组）
   渲染同时产出 copy product → WeakMap（以渲染数组身份为键）
```

**2. 常驻 chrome**

```
宿主 ctx ──▶ host-data.ts ──▶ snapshots.ts ◀── ui-metrics / usage-ledger / output-speed
                                    ▲            git-changes / quota-store
git-changes ──▶ footer           chrome/install.ts ──▶ ui.setEditorComponent / setWidget / setFooter / setHeader
quota-store ──▶ footer                                    （每次安装都 best-effort，失败只退避）
```

**3. 选区复制**

```
组件渲染 → copy product（列区间 + 语义种类 + breakBefore）→ WeakMap
用户选区 → 已提交帧的盒子（structure.ts）→ serialize.ts 解析 → 逻辑文本（或 native-fallback）
```

## 由测试强制的边界

| 不变量 | 强制方式 |
| --- | --- |
| 显示运行时（`src/**` 除 `src/todo/`）**不注册工具、不改写结果、不监听上下文钩子** | `test/package.test.mjs`：禁止 `registerTool`/`setActiveTools`/`sendMessage`/`sendUserMessage`/`setSystemPrompt`/`registerShortcut`/`setTheme`，禁止 `.on("tool_result"｜"tool_call"｜"context"｜"before_agent_start")` |
| 持久化只有一处例外 | 同测试：`appendEntry` 只允许出现在 `src/turn-summary.ts` |
| `src/chrome/**` 不直接 import 宿主包 | `test/chrome.test.mjs`（遍历目录，覆盖新增模块） |
| 除 chrome 外，`src/` 里唯一 import 宿主包的模块是 `src/skill-mux.ts`（需要宿主的 `loadSkills`/`stripFrontmatter` 与补全类型） | 现状如此，新增 `src/` 宿主 import 前先确认真的没有窄接口可用 |
| 工具来源核对 | 运行时校验 `sourceInfo.source === "builtin"` 且 `path === "<builtin:name>"` |
| 依赖版本纪律 | `test/package.test.mjs`：`marked` 必须与宿主 pi-tui 同版本；其余依赖必须与 vendored manifest 一致；`pi.skills`/`pi.prompts` 必须为空 |
| 入口清单 | 同测试：`pi.extensions` 必须精确等于那两项，且各入口文件与 vendor 载荷存在 |

## 安装安全与还原

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| 符号占用标记 + 源码校验 | `adapter.ts` | 第二份副本、已被别人改过、接口形状变了 → 整块退避并给出原因 |
| 每帧归属核对（`ownsMethods`） | `adapter.ts` | 后来者替换了包装 → 立即停止接管，卸载时不覆盖后来者 |
| 只删自己的工厂（身份比较） | `chrome/install.ts` 的 `restore` | 后继扩展的 editor/footer/header 不被误删 |
| generation 失效 | 同上 `invalidate` | 预加载在会话切换/关闭后才完成时，丢弃过期安装 |
| `(prototype, method)` 守卫 | `src/skill-tokens.ts` | 两个 skill 补丁打同一宿主类，缺方法维度会静默丢掉第二个 |

## 时间与轮询模型

| 时钟 | 位置 | 纪律 |
| --- | --- | --- |
| 交互时钟 | `ui-metrics.ts` | 每个用户可见交互只有一个；**时长只在 `agent_end` 记账**，定时器只读快照 |
| Working 动画 | `chrome/working.ts` | 仅 active 期间；`unref()`；帧内不扫会话、不读盘、不查额度 |
| 额度轮询 | `quota/quota-store.ts` | 单飞行；失败保留上次好值 |
| churn 轮询 | `git-changes.ts` | 2 秒 + 250ms 活动去抖；5 秒 git 超时；失败保留上次值 |
| 历史窗口 | `chrome/history-window.ts` | 5000 行预算；越界缓存按需释放 |

## 改代码该动哪里

| 想做的事 | 动这些 |
| --- | --- |
| 新增/调整一个配置键 | `config.ts`（`AppearanceConfig` + `DEFAULT_CONFIG` + `validateConfig`）→ [configuration.md](configuration.md) → `test/config.test.mts` |
| 改 footer 的段落或优先级 | `chrome/footer.ts` + `segments.ts` → [working-footer.md](features/working-footer.md) |
| 新增一个工具行的渲染槽 | `tool-names.ts`（类型与工具名）→ `renderers.ts`（装配）→ `adapter.ts` 的映射（若需新 selector） |
| 新增常驻界面块 | `src/chrome/<name>.ts` + 在 `chrome/install.ts` 里安装/还原 + `chrome/snapshots.ts` 提供数据 → 在 `test/chrome.test.mjs` 的规则范围内（不得 import 宿主包） |
| 改思考/转录协调逻辑 | `transcript-state.ts`（run 归并**单一实现**）+ `transcript-adapter.ts` → [thinking.md](features/thinking.md) |
| 加一个模型侧工具 | 只能放进 `extensions/todo.ts` / `extensions/goal.ts` 那一类非显示入口——显示运行时的边界由 `test/package.test.mjs` 强制 |
| 改宿主接口适配 | `host-data.ts`（桥）与 `adapter.ts`（工具行）；两者都要保持"形状不认识就退避" |

## 验证

`test/package.test.mjs`（边界与清单）、`test/chrome.test.mjs`（chrome 模块规则）、`test/host-data.test.mts`、`test/adapter.test.mjs`；结构类改动请一并跑 `npm run verify` 与 `npm run test:pty`（见 [development.md](development.md)）。
