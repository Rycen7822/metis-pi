# 命令与操作速查

配置文件、默认值及功能开关见 [配置参考](configuration.md)，详细行为从 [功能导航](README.md) 进入。

## 斜杠命令

| 命令 | 用途 |
| --- | --- |
| `/codex-ui` | 查看显示组件安装/退避、配置、统计来源和复制状态；见 [诊断](features/diagnostics.md)。 |
| `/execution [project]` | 管理保留的执行设置；默认全局，可选受信任项目。 |
| `/goal [objective]` | 空参数查看，目标文本创建/替换；`pause` / `resume` / `edit` / `clear` 管理目标。 |
| `/pruner` | 历史压缩设置与状态；常用 `status`、`settings`、`on`、`off`、`compact-chains`，见 [condense](features/condense.md)。 |
| `/dynamic-agents [reload]` | 查看动态全局指令；`reload` 标记下一次 run 刷新。 |
| `/skill:<name>` 或 `￥<name>` | 调用 skill，一次输入可组合多个；见 [skills](features/skills.md)。 |

`/settings`、`/reload` 及 `/llama` 等宿主命令由 Pi 提供。

## 模型侧工具

| 工具 | 契约入口 |
| --- | --- |
| `create_goal` / `get_goal` / `update_goal` | 显式授权、预算、完成与阻塞规则见 [goal](features/goal.md)。 |
| `context_tree_query` | 证据目录、工具输出/参数及历史消息分页恢复，见 [condense](features/condense.md)。 |
| `exec_command` / `write_stdin` / `exec` / `wait` 等 | 工具由 Pi 集合选择，见 [执行模块](codex.md)。 |
| `edit` / `write` 的 `then_run` | 启用 Action Fusion 时可在修改后执行显式命令，见 [融合调用](features/action-fusion.md)。 |

显示适配只认领明确的 Pi 内建来源及本包执行模块的指定工具。第三方同名工具保留自身 renderer；独立安装同名 condense/execution 扩展仍需按各功能页处理冲突。

## 键盘与鼠标

显示层读取宿主键位，不另注册一套快捷键。下面是默认键位；执行模块后台 shell 面板另外注册可配置快捷键。

| 操作 | 行为 |
| --- | --- |
| `ctrl+c` | fullscreen 有选区时复制逻辑文本并保留草稿；无选区时交回宿主清空/退出行为。 |
| `ctrl+o` | 宿主展开工具或 skill；提示跟随宿主键位。 |
| `ctrl+t` | 宿主全局显示/隐藏思考。 |
| `esc` | 宿主打断当前运行。 |
| `alt+w` / `alt+q` / `alt+e` / `alt+r` | 执行模块后台 shell 面板的展开、上一项、下一项、关闭；可在 `/execution` 中配置，默认 `alt+q` 可能与宿主冲突。 |
| 思考块单击 / 双击 / 滚轮 | 折叠与窥视窗切换、全展开切换、窗口内滚动；规则见 [thinking](features/thinking.md)。 |
| skill 条目左键 | 展开/折叠；修饰键点击交给文本选择。 |
| 工具行左键 | 沿用宿主展开行为。 |
| fullscreen 正文拖拽 | 生成应用选区；与终端原生选区的边界见 [复制](features/selection-copy.md)。 |

## 文件与写入边界

| 数据 | 路径或归属 | 写入行为 |
| --- | --- | --- |
| 显示配置 | `<agentDir>/metis-pi.json` | 插件只读；改后重新启动。 |
| goal / 交互摘要 | Pi 会话 custom entries | goal 持久化状态；显示摘要由 `summary.persist` 控制。 |
| 压缩与执行原文 | 会话旁的 `<sessionId>-blobs/` | 归档日志、sidecar 和融合 journal；保留/恢复规则见 [condense](features/condense.md)。 |
| 动态全局指令 | `<agentDir>/dynamic-agents.json` 及选中的策略文件 | 配置与策略只读；会话可追加程序来源元数据。 |
| 执行配置 | `metis-pi.json.execution` | `/execution` 原子写选定范围，保留其他 section。 |

Git footer 只读工作树/index/对象，不写临时对象，不运行外部 diff/textconv。write 预览跟踪仅持有进程内前后镜像。显示层保留工具参数、执行结果与模型上下文；其摘要持久化，以及 goal/condense/dynamic-agents/Action Fusion/execution 的显式功能，由各自契约定义，不能套用全包“只读”的承诺。
