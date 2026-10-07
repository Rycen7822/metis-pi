# 转录、工具输出与思考

appearance 提供紧凑显示，保留工具参数、执行结果、模型正文和各调用的展开状态。配置见 [配置参考](../configuration.md)，未生效时查看 `/codex-ui`。

## 命令与探索

```text
• Explored
  └ Read src/server.ts (lines 1–120)
• Ran npm test
  └ Running unit tests...
    … +24 lines (ctrl+o to expand)
    tests passed
```

| 内容 | 显示规则 |
| --- | --- |
| bash 命令 | `Running` → `Ran`；换行前高亮，词法状态跨行保持，续行用 `│`，折叠预算 2 个屏幕行。 |
| 普通输出 | 首行 `└`，其余缩进；折叠预算 5 个屏幕行，长输出保留首尾与展开提示；单逻辑行先受 1200 字符安全上限限制。 |
| 错误 | 前景标红，保留错误证据。 |
| read / grep / find / ls | `Exploring` / `Explored`，成功结果默认折叠，各结果仍独立。 |
| 本包 exec_command | 命令 call 共用 bash 换行、高亮和复制信息；结果布局和后台会话由执行模块负责。 |

展开提示跟随宿主键位。预算按终端列宽和物理行处理，不直接按 UTF-16 长度裁列；控制序列仅在显示副本中清理。第三方 Web、MCP、LSP、subagent 或同名工具保留 renderer。图片使用宿主协议并服从 `terminal.showImages`，关闭预览只报数量，不输出 Base64。

## 文件修改与 write 预览

- diff 显示行号、增删符号和正文；增删行使用整行底色，context 无底色，续行对齐正文。颜色降级见 [配置](../configuration.md#颜色能力)。
- write 捕获真实执行前后镜像：新文件显示 Added，覆盖写在可核实时显示增删。二进制、过大、不可读、post 不匹配或 diff 预算不足时回退内容预览；diff 搜索数组合计上限 4 MiB。
- 流式 write 显示标题、阶段与尾部正文；`writePreview.rows` 控制整块屏幕预算。预览不表示内容已经写入，跟踪状态只存内存。
- [Action Fusion](action-fusion.md) 分开显示修改和命令；命令后改写文件不会污染已冻结的修改 diff。

## 思考块

流式形态、结束形态和窗口行数由 `thinking.*` 控制。折叠显示 `Thought for …`，缺可靠时长时仅显示 `Thought`；窥视显示最新已渲染行，全展开保留整段正文。

| 操作 | 结果 |
| --- | --- |
| 单击折叠块 / 窥视或全展开块 | 打开窥视 / 折叠。 |
| 双击折叠或窥视块 / 全展开块 | 全展开 / 回到窥视。 |
| 窥视窗内滚轮 | 窗口内滚动，到边缘交回正文；回到最新行恢复跟随。 |
| Shift/Ctrl/Alt 点击 | 交给文本选择。 |

单击延后 300 ms 以识别双击；进行中和结束块规则相同，`ctrl+t` 保留宿主全局行为。结束自动切换一次，用户后续选择不会被重建覆盖。

连续 thinking 块形成语义 run，任何非 thinking 块（含空 text）切开 run；全空 run 不生成组件，历史时长不伪造。单个超大工具组件或思考 run 仍可能完整排版一次后裁切。

## 安装与诊断

来源/形状守卫和恢复规则见 [兼容性](../compatibility.md)。交互 TUI 精确过滤 pi-web-access 的一条旧能力警告：

```text
Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.
```

其他警告、错误和 notify 保留；仅覆盖当前 TUI 生命周期，不改变 Web 工具启用方式。

输出布局位于 `src/renderers.ts`、`shell.ts`、`diff.ts`、`write-preview.ts`，快照由 `write-tracker.ts` 持有；思考交互由 `thinking-view.ts` 与 `transcript-state.ts` 持有。
