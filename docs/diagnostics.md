# 诊断与排查

显示问题先运行 `/codex-ui`，命令报告当前进程的实际状态，未知值显示 `—`。

| 现象 | 检查 |
| --- | --- |
| 界面或工具行未生效 | `chrome`、`transcript`、`decorations` 的安装与退避原因。 |
| 修改配置无变化 | `config` 有效值、agentDir 和重启；见 [配置](configuration.md)。 |
| token、cache、Git 数字不同 | 数据 scope 与 [统计口径](features/interface.md#统计口径)。 |
| 复制异常 | `selection-copy`、`copy-stats` 的模式、失败及外来包装，见 [复制](features/selection-copy.md)。 |
| 历史暂时不可见 | `history-window` 页边界，向对应方向继续滚动。 |
| 动态指令或精简不符 | `/dynamic-agents` / `/pruner status`，它们独立于显示配置。 |

## 诊断字段

| 字段 | 内容 |
| --- | --- |
| 首行 | metis/Pi 版本、模式和宿主快照 revision。 |
| `composer` / `working` / `chrome` | editor、metadata、Working、header/footer 的实际安装状态。 |
| `footer` / `model` / `context` / `session` / `cache` / `speed` | 模型与统计来源、实时/确认值及 scope。 |
| `interaction` / `outcome` | 时钟与终止证据。 |
| `transcript` / `decorations` / `thinking` | 接管、退避、装饰失败及思考策略。 |
| `fullscreen-margin` / `history-window` | 留白、窗口、页边界和预算。 |
| `glyphs` / `config` / `resources` | 字形计数、有效配置、timer/widget。 |
| `git-changes` | HEAD/空树计数和采样参数。 |
| `selection-copy` / `copy-stats` | 镜像降级、`other-wrapper`、复制模式/字数/耗时和失败。 |

无活动会话时返回 `no active session`。此命令由 `src/diagnostics.ts` 装配，不验证所有外部服务或插件；运行覆盖见 [VALIDATION](../VALIDATION.md)。
