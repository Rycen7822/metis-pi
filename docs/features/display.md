# 转录显示

Metis 格式化命令、文件修改、Codemode 和思考块。工具入参、回执和模型收到的内容不变。用 `/codex-ui` 查看当前生效的显示组件。

## 命令与探索

```text
• Explored
  └ Read src/server.ts:1-120
• Ran npm test
  └ Running unit tests...
    … +24 lines (ctrl+o to expand)
    tests passed
```

`read`、`grep`、`find`、`ls` 与 `neural_search` 显示为 `Exploring` 或 `Explored`。能确定参数的只读 Shell 命令也会显示为 `Read`、`Find` 或 `Search`。有变量展开、通配符等动态参数，或不能识别实际 Shell 时，显示原命令。PowerShell 与 CMD 也显示原命令。

Bash 标题默认显示两行，结果预览显示五行。用宿主的展开键查看可用的完整输出。`exec_command` 的灰、绿、红点依次表示尚在运行、成功退出和失败；`write_stdin` 的输出也按命令结果排版。运行时截断的输出需从工具回执中的路径[读取](../execution.md)。图片使用 Pi 的显示协议与 `terminal.showImages` 设置。

## Codemode

| 区域 | 如何查看 |
| --- | --- |
| 脚本 | 生成时预览末尾，完成或中断后自动收起。点击标题或脚本切换预览与全文。 |
| 子调用 | 默认显示最近 8 次。展开较早调用的提示可查看其余内容；点击单项只改变该项。 |
| 脚本结果 | 默认隐藏，点击 `Took …` 查看。脚本、子调用和结果各自展开；宿主的全局展开键可以一起控制。 |

运行中的子调用进度按界面实际绘制的帧显示；两帧之间被替换的中间预览不会逐个绘制。这不改变执行事件、最终回执或失败计数。

已保存的回执缺少嵌套详情时，只显示可用的摘要。启用 Condense 时，可以用 `context_tree_query` [回读归档](condense.md#原文与分页恢复)。子代理只读查看器使用同类布局；可用内容取决于保存的回执。

## 文件修改与 write 预览

- edit 和 write 的 diff 默认从第一处增删开始预览五个屏幕行。单击正文或按展开键可查看上下文。无法核实写入前后的内容时，显示预览而非 diff。
- `appearance.writePreview.enabled` 控制流式预览。`rows` 接受 0–64；设为 0 时只显示标题与阶段。预览不是写入结果，以工具回执为准。
- 带 [`then_run`](action-fusion.md) 的修改分开显示 diff 和命令输出。diff 不包含后续命令对文件的修改。

## 思考块

默认在生成时预览最新六行，结束后折叠。可在 `[appearance.thinking]` 修改流式和结束时的显示方式。折叠时显示 `Thought`，有时长数据时显示 `Thought for …`。

| 操作 | 行为 |
| --- | --- |
| 左键 | 在折叠和可滚动预览间切换；全部展开时不动作。 |
| 右键 | 在全部展开和折叠间切换。 |
| 预览内滚轮 | 滚动预览；到边缘后继续滚动转录。 |
| Ctrl+T | 使用 Pi 的思考显示绑定。 |

全屏的历史分页和跳转见[界面指南](interface.md#全屏历史与留白)。
