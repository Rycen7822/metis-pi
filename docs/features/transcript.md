# 工具行与转录显示

appearance 为 Pi 内建工具及本包转换层的指定工具提供紧凑显示。参数、执行结果和存储正文保持；每个调用保留自己的展开状态。总开关及预览预算见 [配置](../configuration.md)，未生效时查看 `/codex-ui`。

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
| bash 命令 | `Running` → `Ran`，换行前做完整语法高亮，词法状态跨行保持；续行使用 `│`，预算为 2 个屏幕行。 |
| 普通输出 | 首行 `└`、后续缩进；换行后预算为 5 个屏幕行，超长输出保留首尾并显示展开提示。单条逻辑行先受 1200 字符安全上限约束。 |
| 错误 | 输出前景标红，错误证据保留。 |
| read / grep / find / ls | 使用 `Exploring` / `Explored` 分组语义，成功输出默认折叠；各调用结果仍独立。 |
| 本包 exec_command | 命令 call 复用 bash 组件的换行、高亮、展开与复制信息；转换层继续负责外层分组、后台会话和结果。 |

展开提示取自宿主的当前键位。排版按终端显示列宽和物理行预算处理，中文、emoji 与软折行不会按 UTF-16 长度直接截列。

## 文件修改与 write 预览

```text
• Edited src/server.ts (+2 -1)
  12  export function startServer() {
  13 -  server.listen(3000);
  13 +  const port = Number(...);
  14 +  server.listen(port);
  15  }
```

- edit/diff 采用“行号、增删符号、正文”，删除/新增使用整行背景 `#4A221D` / `#213A2B`，256 色对应 52/22，16 色保留前景。语法高亮 reset 不清掉 diff 背景，续行对齐正文列，context 行无背景。
- write 在执行前后捕获真实镜像。新文件显示 Added，覆盖写在可核实时显示真实增删；二进制、过大、不可读、post 不匹配或搜索预算不足时回退原内容预览。diff 搜索数组合计预算为 4 MiB，整块无共同正文行的改写可直接生成精确增删。
- 模型仍在生成 write 参数时显示标题、阶段和尾部正文。`writePreview.rows` 是整块屏幕行预算，`0` 仅保留标题与阶段；有正文预算时至少保留一行。跟踪状态只在内存中存在。
- [Action Fusion](action-fusion.md) 分别显示修改和命令结果；命令之后改写文件不会污染已冻结的修改 diff。

## 图片、摘要与显示范围

图片继续使用宿主原生协议并服从 `terminal.showImages`；关闭预览时只显示数量，不输出 Base64。启动身份行、Working、结束摘要及终止状态见 [Working 与 Footer](working-footer.md)，思考块见 [thinking](thinking.md)。

第三方 Web、MCP、LSP、subagent 或同名工具保留自己的 renderer。本包没有跨调用合并存储结果；全展开保留文本正文，终端控制序列只在显示副本中清理。单个超大组件仍可能完整排版一次再裁切。

## 安装、退避与启动提示

工具行 adapter 检查宿主形状、builtin/本包入口来源和包装器所有权；不匹配时退避，单行渲染失败时使用原生显示，卸载只恢复自己仍拥有的方法。完整机制和版本范围见 [兼容性](../compatibility.md)。

启用 metis-pi 的交互界面期间，会精确过滤 pi-web-access 的以下兼容性回退警告，避免重新加载扩展时写进输入区：

```text
Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.
```

其他警告、附加诊断、console.error、工具结果和 UI notify 保留。过滤只覆盖该 TUI 生命周期，不区分来源是主会话还是子代理；启动前、退出后和独立非交互进程保持原行为，Web 工具的启用方式也不变。

## 实现与验证

`src/adapter.ts` 负责接管，`renderers.ts` / `shell.ts` / `diff.ts` 负责布局，`write-tracker.ts` / `apply-patch-view.ts` 提供可靠修改快照。对应 adapter/host-entry、renderer/shell/write、transcript 与严格 PTY 的职责见 [开发说明](../development.md)，实测范围见 [VALIDATION](../../VALIDATION.md)。
