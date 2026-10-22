# 诊断与排查

显示问题先运行 `/codex-ui`。结果反映当前进程，未知值显示 `—`；无活动会话返回 `metis-pi: no active session`。

| 现象 | 检查 |
| --- | --- |
| 工具行或界面未生效 | chrome、transcript、decorations 的安装状态和退避原因。 |
| 配置无变化 | config 的有效值和 agentDir，按[生效方式](configuration.md)重载。 |
| 用量、速度或 Git 数字不同 | 数据 scope 和[统计口径](features/interface.md#统计口径)。 |
| 复制异常 | selection-copy、copy-stats 的模式、失败和外来包装。 |
| 历史暂不可见 | history-window 页边界，继续向相应方向滚动。 |
| 指令或精简不符 | `/dynamic-agents` / `/pruner status`。 |

## 诊断字段

| 字段 | 内容 |
| --- | --- |
| 首行 | Metis/Pi 版本、模式、宿主快照 revision。 |
| composer / working / chrome | 输入区、metadata、Working、header/footer 安装状态。 |
| footer / model / context / session Σ / cache(last) / output speed | 当前或已确认值、来源和 scope。 |
| interaction / outcome | 时钟与终止证据。 |
| transcript / decorations / thinking | 接管、退避、失败与思考策略。 |
| fullscreen-margin / history-window | 留白、页边界、预算、滚动条桥接。 |
| glyphs / config / resources | 字形计数、有效配置、timer/widget。 |
| git-changes | HEAD/空树计数、采样参数。 |
| selection-copy / copy-stats | 镜像降级、other-wrapper、模式、字数、耗时与失败。 |

命令由 `src/appearance/diagnostics.ts` 装配，只诊断本进程集成；网页、LSP、MCP 和子代理分别使用对应状态入口，外部服务需实际请求验证。
