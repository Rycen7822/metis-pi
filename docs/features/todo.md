# codex-todo 任务子插件

> 带常驻输入框上方面板与子任务树的磁盘持久化任务列表。融合 rpiv-todo（面板工程）、pi-goal-x（长任务推进）、pi-agent-extensions todos（持久化与认领）。

| | |
| --- | --- |
| 入口 | `extensions/todo.ts`（第三个扩展入口） |
| 实现 | `src/todo/model.ts`（纯模型）`src/todo/store.ts`（磁盘）`src/todo/tools.ts`（模型侧工具）`src/todo/widget.ts`（面板）`src/todo/commands.ts`（命令） |
| 工具 | `todo`（单工具 + `action` 分发） |
| 命令 | `/todos`、`/todos-doctor` |
| 存储 | `<cwd>/.pi/codex-todos/tasks.json`（可用 `PI_CODEX_TODO_PATH` 搬迁） |

## 常驻面板

```
Todos 2/5 done
○ #1  重构 store
◐ #2  补测试
+1 more (1 completed, 0 pending)
```

- 标题 `Todos N/M done` + 树形行；状态符 `○ ◐ ✓ ✗ ⚠︎`（`src/todo/model.ts` 的 `TASK_GLYPHS` / `taskGlyph`，**只有存在 `blockedBy` 时才**显示层级路径列）。
- 默认显示 **3 行任务**，超出时尾部折叠成汇总行 `+N more (a completed, b pending)`：**先丢已完成、再截断未完成**（pending 优先保留）。
- **左键单击任意行**展开完整列表（汇总行消失、标题变 `▴ · click to collapse`），再点收回三行视图；展开态**写盘**，重启保留。
- **右键（按下即触发）单击任意行**手动隐藏面板（隐藏态写盘，重启仍隐藏）；再执行一次 `/todos` 即恢复。
- **无键盘快捷键**（0.17.3 起移除原 `ctrl+shift+t`），交互全部走鼠标。右键用"按下"是因为 Warp 等终端会吃掉右键松开事件。
- 首帧锁定高度、实时更新不会缩行（防终端跳动）；显式展开/收起才允许改高。不建立刷新定时器；主动变更请求重绘，宿主渲染时按文件 dev/inode/size/mtime/ctime 指纹检查外部编辑。未变时复用解析快照与未着色任务行，仍响应宽度、会话、回合、折叠和主题变化。

## 列表生命周期

- **默认新建**：对一个已完成（全部 complete/skipped）的列表再 `add`，会**开一张新列表**——旧任务清空，绝不把历史任务追加到新工作后面。
- 只有列表**还有未完成任务**时才追加（"非必要不追加"）。已完成列表本身就是历史，`gcDays`（默认 7）会回收；store 只保存**正在做的那张列表**。
- 每次新建都会明确回报：`(new list: M finished task(s) cleared; ids restart at #1 — earlier #id references are void)`——这一句就是给模型的"旧引用作废"提示。
- **"刚完成"只对本会话亲眼看到完成的那些任务成立**：store 按 workspace 落盘、重启后 turn 计数从 0 重来；若不看完成时刻，上次会话已做完的列表每次启动都会重新弹出（0.19.1 修掉的就是这个）。
- 收起的触发信号是**真正的用户 prompt**（宿主 `input` 事件）：任何用户输入（新 prompt、agent 干活途中打字的 steer、排队的 follow-up）一到就折叠并刷新可见性，全部完成的面板随之消失。**不用**宿主的 `turn_start`——它的粒度是模型往返，会在同一次请求内就折叠。

## 任务编号（层级路径）

| 概念 | 规则 |
| --- | --- |
| 路径 | 顶层 `#1` 起，子任务 `#1.1` / `#1.2`，孙辈 `#1.1.1`，**最多 4 层**（`MAX_DEPTH`） |
| 每张列表 | 都从 `#1` 重新开始（内部数字 id 仅用于存储，从不出现在界面或工具输出里） |
| 工具入参 | 同一套路径：`"1"`、`"1.2"`，`#` 可省；顶层也接受数字 |
| 找不到时 | 错误列出当前所有路径，例如 `task #2 not found — current paths: #1, #1.1`（便于模型自我纠正） |
| 规模上限 | `MAX_TASKS` = 15 |

## 子任务树与完成门禁

- 模型提交**扁平** `[{title, parentId}]`；显示层直接读取模型生成的深度优先任务行，移动任务后按实际父子关系计算缩进，不依赖创建顺序。
- 每行显示任务自身的持久化状态；子任务结束不会自动完成父任务，父任务仍需显式 `complete`。不再维护无人消费的另一套派生状态树。
- `complete` 默认**门禁**：存在未完成子任务，或缺少非空证据时会被拒绝；若证据里出现文件路径，会检查文件**真实存在**（`src/todo/tools.ts` 用 `existsSync`，相对路径按 cwd 解析）。
- 证据记为 **UNTRUSTED claim**（记录文本，不代表已核实语义）。
- `blockedBy` 支持增量增删（`addBlockedBy` / `removeBlockedBy`），**waits-for 环检测**拒绝成环；`skip` 级联留痕。
- 移动/改父时会检测环（`move: #1.2 is a descendant of #1.1 (cycle)`）。

## subagent 认领

`claim` / `release`（支持 `force` 夺取）：认领即置 `in_progress`；跨进程写操作由 `<cwd>/.pi/codex-todos/tasks.lock` 保护（`0600` + `wx` 独占创建，**TTL 30 分钟**，过期锁自动归档成 `stale-lock-<session>-<at>.json`）。被他人认领时 `claim` 报错并提示 `retry with force to take it over`。

## 存储与损坏处理

- `<cwd>/.pi/codex-todos/tasks.json`，带 `version` 字段、**原子写**。
- 损坏（JSON 解析失败或结构不合法）→ 归档成 `tasks.json.bak-<ts>` 并空载，**绝不让会话崩溃**；`/todos-doctor` 可查。
- 权限或 I/O 错误不视为缺失/损坏，不归档文件或缓存为空任务；已显示的面板明确显示不可用，并在下一次成功读取时恢复。
- `gcDays` 默认 7，清理已完成列表。

## 模型侧工具行为

单 `todo` 工具 + `action` 分发（`list` / `add` / `update` / `complete` / `skip` / `reopen` / `claim` / `release` / `addBlockedBy` / `removeBlockedBy`）：

- 校验错误**抛出并附纠正提示**（让模型自我修正）。
- **无变更返回 `No change: …` 成功结果**（防重试循环），例如 `No change: nothing to update (pass title and/or parentId)`。

## 撞名（部署注意）

另有两个同名扩展会抢占工具名 `todo` 与命令 `/todos`：mitsuhiko/agent-stuff 的 `extensions/todos.ts`（文件式 `.pi/todos/*.md`）与 pi-agent-extensions 的 `extensions/todos/index.ts`。**必须禁用其一**：

- 工具名冲突是**静默后写覆盖**；命令冲突会退化成 `/todos:2`——不要靠运气。
- 禁用方式：在 `~/.pi/agent/settings.json` 对应包的 `extensions` 数组里写 `"-extensions/todos.ts"`（`-` 前缀 = 强制排除）。
- 本扩展检测到工具名被占时**只警告一次、不刷屏**；store 与命令仍然可用。
- 存储目录刻意不同名（`.pi/codex-todos`），双装过渡期互不踩数据；迁移旧列表用 `todo` 工具的 `add` 把 `.pi/todos/*.md` 内容转成任务即可。

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| 任务模型（纯函数，无 fs / 无 pi / 无时间源） | `src/todo/model.ts`（`TASK_GLYPHS`、`taskGlyph`、`MAX_TASKS`、`MAX_DEPTH`、`completionBlock`、`startNewList`、`pathOf`、`taskRows`） |
| 磁盘 store | `src/todo/store.ts`（`TODO_DIR_NAME`、`TODO_STATE_FILE`、`TODO_LOCK_FILE`、`LOCK_TTL_MS`、`DEFAULT_GC_DAYS`） |
| 工具 | `src/todo/tools.ts` |
| 面板 widget | `src/todo/widget.ts` |
| 命令 | `src/todo/commands.ts` |
| 入口接线 | `extensions/todo.ts` |

## 不变量与已知限制

- 面板"刚完成"的可见性只在**本会话**可靠；这是 turn 计数从 0 重来的必然结果，不是 bug。
- 编号在**同一张列表内**唯一：新建列表会复用 `#1`，所以那一刻必须靠工具回报的提示告知模型旧引用作废。
- 证据是 UNTRUSTED claim：只做"非空 + 文件存在"级别的检查，不核验内容是否符合语义。
- 最多 4 层、15 个任务：超限直接拒绝而不是静默截断。

## 验证

`test/todo/todo-model.test.mts`、`test/todo/todo-store.test.mts`、`test/todo/todo-tools.test.mts`、`test/todo/todo-widget.test.mts`、`test/todo/todo-extension.test.mts`；`scripts/pty-verify.mjs` 覆盖真实 TUI 的面板展开/收起、`+N more`、完成后收起。
