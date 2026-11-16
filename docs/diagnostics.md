# 诊断与排查

`/codex-ui` 是排查显示问题的第一入口。它只反映当前进程。未知值显示为 `—`；没有活动会话时输出 `metis-pi: no active session`。

| 现象 | 检查项 |
| --- | --- |
| 工具行或界面没有生效 | chrome、transcript、decorations 的安装状态与退避原因。 |
| 配置改动没有体现 | config 的有效值与 agentDir。按[生效方式](configuration.md)重载。 |
| 用量、速度或 Git 数字可疑 | 数据范围与[统计口径](features/interface.md#统计口径)。 |
| 复制行为异常 | selection-copy、copy-stats 的模式、失败与外部包装。 |
| 历史暂时缺失 | history-window 的页边界。向对应方向滚动即可。 |
| 指令或精简结果不符合预期 | `/dynamic-agents`、`/pruner status`。 |

## 诊断字段

| 字段 | 内容 |
| --- | --- |
| 首行 | Metis 与 Pi 版本、运行模式、宿主快照 revision。 |
| composer、working、chrome | 输入区、metadata、Working、header 与 footer 的安装状态。 |
| footer、model、context、session Σ、cache(last)、output speed | 当前值或已确认值，以及来源和范围。 |
| interaction、outcome | 时钟与终止证据。 |
| transcript、decorations、thinking | 接管情况、退避、失败，以及思考策略。 |
| fullscreen-margin、history-window | 留白、页边界、预算、滚动条桥接。 |
| glyphs、config、resources | 字形计数、有效配置、timer 与 widget。 |
| git-changes | HEAD 与空树计数、采样参数。 |
| selection-copy、copy-stats | 镜像降级、其他包装、模式、字数、耗时与失败。 |

这些字段由 `src/appearance/diagnostics.ts` 汇总，只覆盖本进程的显示集成。网页、LSP、MCP 和子代理各有自己的状态入口。外部服务是否可用，需要发起一次真实请求来确认。
