# 操作速查

默认值、配置路径和禁用方法见 [配置参考](configuration.md)。

## 命令与工具

| 命令 | 用途 |
| --- | --- |
| `/codex-ui` | 查看显示组件、有效配置、统计与复制状态；见 [诊断](diagnostics.md)。 |
| `/execution [project]` | 修改全局或受信任项目的执行设置。 |
| `/goal [objective]` | 查看或创建目标；`pause`、`resume`、`edit`、`clear` 管理目标。 |
| `/pruner` | 历史精简与恢复；常用 `status`、`settings`、`on`、`off`、`now`、`compact`。 |
| `/dynamic-agents [reload]` | 查看指令状态，或标记下一次 run 刷新。 |
| `/skill:<name>` / `￥<name>` | 调用 skill，可在一次输入中组合多个。 |

`/settings`、`/reload` 等宿主命令由 Pi 提供。

| 模型侧工具 | 契约 |
| --- | --- |
| `create_goal` / `get_goal` / `update_goal` | [目标授权、预算和完成规则](features/goal.md)。 |
| `context_tree_query` | [历史证据、参数及原文分页回读](features/condense.md)。 |
| `exec_command` / `write_stdin` / `view_image` | [deferred 进程与图片工具](execution.md)。 |
| `change_reasoning` | 开启执行配置 `autoReasoning` 后，按当前模型能力提供。 |
| `edit` / `write` 的 `then_run` | [修改成功后执行明确命令](features/action-fusion.md)。 |

工具选择和原生 `codemode` 由 Pi 管理。显示适配只接管来源明确的工具；同名第三方 renderer 保留，重复工具注册仍需停用冲突扩展。

## 按键与鼠标

| 默认操作 | 行为 |
| --- | --- |
| `ctrl+c` | fullscreen 有选区时复制并保留草稿；无选区时交回宿主。 |
| `ctrl+o` / `ctrl+t` / `esc` | 宿主的展开、思考显示和中断；提示跟随实际键位。 |
| `alt+w` / `alt+q` / `alt+e` / `alt+r` | 后台 shell 面板展开、上一项、下一项、关闭；可在执行配置中修改。 |
| 思考块单击 / 双击 / 滚轮 | 折叠、窥视、全展开及窗口滚动，见 [转录显示](features/display.md#思考块)。 |
| skill 左键 / 工具行左键 | 切换 skill 折叠 / 沿用宿主展开行为。 |
| fullscreen 正文拖拽 | 应用选区；修饰键点击和终端原生选区见 [复制](features/selection-copy.md)。 |
