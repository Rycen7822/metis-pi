# 转录显示

Metis 格式化命令、文件修改、Codemode 和思考块。显示层负责终端呈现；工具参数、回执和模型输入由执行与协议层管理。用 `/codex-ui` 查看当前生效的显示组件。

## 命令与探索

```text
• Explored
  └ Read src/server.ts:1-120
• Ran npm test
  └ Running unit tests...
    … +24 lines (ctrl+o to expand)
    tests passed
```

`read`、`grep`、`find`、`ls` 与 `neural_search` 显示为 `Exploring` 或 `Explored`。参数可静态解析的只读 Shell 命令也会显示为 `Read`、`Find` 或 `Search`。Shell 类型未知或参数包含变量展开、通配符等动态内容时，标题保留原命令。PowerShell 与 CMD 同样保留原命令。

Web Access 与命令工具共用一套缩进：工具标题从 `•` 开始，参数续行用 `│`，结果从 `└` 开始，后续行对齐结果正文。直接调用和 Codemode 子调用使用相同布局。

Bash 标题默认显示两行，结果预览显示五行。用宿主的展开键查看可用的完整输出。`exec_command` 的灰、绿、红点依次表示尚在运行、成功退出和失败；`write_stdin` 的输出也按命令结果排版。运行时截断的输出需从工具回执中的路径[读取](../execution.md)。图片使用 Pi 的显示协议与 `terminal.showImages` 设置。

## Codemode

| 区域 | 如何查看 |
| --- | --- |
| 脚本 | 生成时预览末尾，完成或中断后自动收起。点击标题或脚本切换预览与全文。 |
| 子调用 | 默认显示最近 8 次。展开较早调用的提示可查看其余内容；点击单项只改变该项。 |
| 待应用修改 | `Stored changes to be applied` 显示目标路径和 diff 预览；点击可展开。卡片描述会话中保存的提案，文件写入由后续应用步骤完成。 |
| 脚本结果 | 默认隐藏，点击 `Took …` 查看。脚本、子调用和结果各自展开；宿主的全局展开键可以一起控制。 |

待应用 diff 的数据源为会话快照；磁盘读取与脚本执行属于后续应用步骤。例如 `store("draft", { path, original, edits })`，其中 `original` 是原始全文，`edits` 是含 `oldText` 和 `newText` 的数组。也支持分开保存的 `*_path` / `*_orig` 和修改数组。每项修改均唯一且互不重叠地匹配同一原文时生成预览；旧回执保持原有显示。

运行中的子调用采用最新绘制帧作为进度预览；执行事件、最终回执和失败计数按原数据记录。

已保存的回执缺少嵌套详情时，只显示可用的摘要。启用 Condense 时，可以用 `context_tree_query` [回读归档](condense.md#原文与分页恢复)。子代理只读查看器使用同类布局；可用内容取决于保存的回执。

## 文件修改与 write 预览

- edit 和 write 的 diff 默认从第一处增删开始预览五个屏幕行。单击正文或按展开键可查看上下文。写入前内容或结果缺失时，显示内容预览。
- `appearance.writePreview.enabled` 控制流式预览。`rows` 接受 0–64；设为 0 时只显示标题与阶段。写入结果以工具回执为准。
- 带 [`then_run`](action-fusion.md) 的修改分开显示 diff 和命令输出。diff 截止于后续命令启动前。

## 思考块

默认在生成时预览最新六行，结束后折叠。可在 `[appearance.thinking]` 修改流式和结束时的显示方式。折叠时显示 `Thought`，有时长数据时显示 `Thought for …`。

| 操作 | 行为 |
| --- | --- |
| 左键 | 在折叠和可滚动预览间切换；全部展开时保持当前状态。 |
| 右键 | 在全部展开和折叠间切换。 |
| 预览内滚轮 | 滚动预览；到边缘后继续滚动转录。 |
| Ctrl+T | 使用 Pi 的思考显示绑定。 |

全屏的历史分页和跳转见 [界面指南](interface.md#全屏历史与留白)。
