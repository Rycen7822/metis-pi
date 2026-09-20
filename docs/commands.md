# 命令 / 工具 / 按键 / 手势 / 路径

一站式速查。配置键见 [configuration.md](configuration.md)，每个功能的行为见对应功能页。

## 斜杠命令

| 命令 | 参数 | 所属 | 作用 |
| --- | --- | --- | --- |
| `/codex-ui` | — | appearance | 能力与数据诊断：各数值来源、统计范围、终止证据、composer/working/footer/quota 组件真实状态、补丁与退避状态 |
| `/codex-ui` | `refresh-quota` | appearance | 手动触发一次额度刷新 |
| `/goal` | — | goal | 查看当前目标状态 |
| `/goal` | `<objective>` | goal | 设定/替换目标 |
| `/goal` | `pause` \| `resume` \| `edit` \| `clear` | goal | 管理目标状态 |
| `/todos` | — | todo | 恢复面板（若被右键隐藏过）+ 以 notify 打印文字任务列表 |
| `/todos-doctor` | — | todo | 只读诊断：坏档归档、过期锁、GC |
| `/skill:<name>` | 后接文字 | 宿主 + skill-mux | 调用 skill；**一次输入可带多个 token**，见 [features/skills.md](features/skills.md) |

本仓库**不注册任何键盘快捷键**（原 `ctrl+shift+t` 已于 0.17.3 移除；todo 面板全部走鼠标）。`/settings`、`ctrl+o`、`ctrl+t`、`esc` 都是宿主行为，我们只读取宿主的当前键位，不改写、不覆盖。

## 模型侧工具

| 工具 | 形态 | 说明 |
| --- | --- | --- |
| `todo` | 单工具 + `action` 分发 | `list` / `add` / `update` / `complete` / `skip` / `reopen` / `claim` / `release` / `addBlockedBy` / `removeBlockedBy`；任务引用是**层级路径**（`"1"`、`"1.2"`，`#` 可省）；无变更返回 `No change:`，校验错误抛出并附纠正提示 |
| `create_goal` / `get_goal` / `update_goal` | 各自独立 | 长任务目标；只在被明确要求时使用，状态走会话记录 |
| Codex 工具层（`exec_command` / `write_stdin` / `apply_patch` / `view_image` / `notebook` 等） | 各自独立 | 由内置 vendor 层注册，见 [vendor-codex-conversion.md](vendor-codex-conversion.md) |

**不接管**任何第三方工具：工具来源经宿主 `sourceInfo` 核对，只有明确来自 pi 内建实现的工具才使用本项目的 renderer。FFF / LSP / MCP / subagent / web 等插件即便覆盖同名工具，也保留它们自己的 renderer 与结果。

## 键盘

| 按键 | 提供方 | 行为 |
| --- | --- | --- |
| `ctrl+c` | 本项目（`selectionCopy.ctrlC`）| **有选区**时复制选区的逻辑文本、不清草稿；**无选区**时交回宿主原生（清空草稿 / 双击退出） |
| `ctrl+o` | 宿主 | 展开当前工具调用；本项目尊重宿主的提示文本，不覆盖自定义键位 |
| `ctrl+t` | 宿主 | 全局显示/隐藏思考块 |
| `esc` | 宿主 | 打断当前运行 |

## 鼠标手势

| 目标 | 手势 | 效果 |
| --- | --- | --- |
| 思考块 | 左键单击 | 在「折叠 ↔ N 行窥视窗」之间切换（延迟 300ms 等双击窗口） |
| 思考块 | 左键双击 | 在「N 行窥视窗 ↔ 全展开」之间切换（折叠态直接双击 = 全展开） |
| 思考块 | 滚轮（指针在窗口上） | 在窥视窗内滚动；到两端后事件落回正文滚动 |
| todo 面板 | 左键单击任意行 | 展开为完整列表 / 再点收回三行视图（展开态写盘） |
| todo 面板 | **右键按下**任意行 | 手动隐藏面板（写盘，重启仍隐藏；`/todos` 可恢复） |
| 折叠的 `[skill]` 条目 | 左键单击 | 展开 / 折叠（`ctrl+o` 依旧可用） |
| 折叠的 `[skill]` 条目 | 带 Shift/Ctrl/Alt 的点击 | 交给文本选择，不切换 |
| 工具行 | 左键单击 | 等同宿主展开该工具调用 |
| 任意正文 | 拖拽 | 生成选区（fullscreen 模式）；`ctrl+c` 复制 |

右键用「按下」而非「松开」触发，因为 Warp 等终端会吃掉右键松开事件。

## 环境变量

见 [configuration.md](configuration.md) §环境变量与§颜色等级判定。速记：`PI_AGENT_DIR`、`PI_CODEX_TODO_PATH`、`NO_COLOR`、`FORCE_COLOR`、`COLORTERM`、`WT_SESSION`、`TERM_PROGRAM`、`TERM`。

## 磁盘路径

| 路径 | 写入者 | 说明 |
| --- | --- | --- |
| `<agent dir>/codex-appearance.json` | 用户 | 配置。**本插件只读，永不改写** |
| `<cwd>/.pi/codex-todos/tasks.json` | todo | 任务列表（带 `version` 字段、原子写）。可用 `PI_CODEX_TODO_PATH` 整体搬迁 |
| `<cwd>/.pi/codex-todos/tasks.json.bak-<ts>` | todo | 损坏存档（`/todos-doctor` 可查） |
| `<cwd>/.pi/codex-todos/tasks.lock` | todo | 跨进程文件锁，`0600` + `wx` 独占创建，TTL 30 分钟 |
| `<cwd>/.pi/codex-todos/stale-lock-<session>-<at>.json` | todo | 过期锁被自动归档到这里 |
| `<os tmp>/pi-codex-churn-*/` | git-changes | 会话私有的 `GIT_OBJECT_DIRECTORY`：churn 计数把文件内容 `git hash-object -w` 到这里比较 |
| 会话记录（session entries） | goal / summary | 目标状态与摘要作为 CustomEntry 追加；无外部数据库 |

## 只读保证（安全边界）

| 子系统 | 承诺 |
| --- | --- |
| git-changes | **不写**用户的 `.git` 索引 / 工作区 / 对象库；用 `GIT_OBJECT_DIRECTORY` 指向临时目录，`hash-object --no-filters` 不触发 diff 驱动与 smudge 过滤器；git 调用带 5 秒超时与 `--no-ext-diff --no-textconv --no-optional-locks`；读取失败保留上次正确数字而非清零 |
| quota | **不读**任何凭据文件、不发私有 HTTP、不 scrape Codex TUI；只经本机已登录 Codex CLI 的 `codex app-server` stdio JSON-RPC |
| 显示层 | 不改写工具参数、执行结果、会话记录、模型上下文、系统提示词；不注册内建同名工具 |
| 配置 | 永不改写用户配置文件 |
| write 追踪 | 只存在于进程内存（ephemeral），不写盘、不进会话记录 |

## 三条边界例外（非显示层入口）

整个仓库只有三处会注册工具/命令/上下文：

1. `extensions/goal.ts` —— 注册 `/goal`、三个 goal 工具，并监听 `session_start`/`session_tree`/`before_agent_start`/`agent_start`/`agent_end`/`context`。
2. `extensions/todo.ts` —— 注册 `todo` 工具与 `/todos`、`/todos-doctor`。
3. `vendor/pi-codex-conversion/dist/index.js` —— 注册 Codex 工具层。

`test/package.test.mjs` 把显示入口（`extensions/appearance.ts` 与 `src/**`）"不注册工具、不改写结果与上下文"这条边界写成了显式测试范围。
