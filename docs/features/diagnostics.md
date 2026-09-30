# 诊断与排查

显示问题先运行 `/codex-ui`，查看当前组件安装、配置与运行状态。

## 常见问题入口

| 现象 | 先检查 |
| --- | --- |
| 工具行或界面外观未生效 | `transcript` / `chrome` / `decorations` 的安装和退避原因。 |
| 改配置后无变化 | `config` 中的有效值；确认文件目录并重启 Pi。加载问题可能静默回退。 |
| token、cache 或 Git 数字不一致 | 各行的 `scope` 与数据来源，见 [统计口径](working-footer.md)。 |
| 复制换行或缩进不正确 | `selection-copy`、`copy-stats` 的模式、失败原因和外来包装，见 [复制](selection-copy.md)。 |
| 旧历史暂时不可见 | `history-window` 的页边界和行预算，继续向相应方向滚动加载。 |
| 动态指令或压缩状态不符 | `/dynamic-agents` 或 `/pruner status`，它们不属于显示配置。 |

## `/codex-ui` 字段

未知数值显示 `—`。命令报告当前进程的实际安装/状态，不以配置期望代替结果。

| 行 | 内容 |
| --- | --- |
| 首行 | 本包/Pi 版本、运行模式和宿主快照 revision。 |
| `composer` / `working` / `chrome` | editor、prefix、metadata、Working、header/footer 的实际安装与动画状态。 |
| `footer` / `model` | model、provider、推理等级和各显示字段的数据来源。 |
| `context` / `session` / `cache` | 当前上下文、会话累计 usage、最近请求与会话加权 cache 口径。 |
| `speed` | 输出 token、观测窗口、实时或确认值的 scope。 |
| `interaction` / `outcome` | 交互/思考时钟及终止证据。 |
| `transcript` / `decorations` / `thinking` | 接管/退避、装饰失败、思考显示策略。 |
| `fullscreen-margin` / `history-window` | 留白、当前历史窗口、页边界和预算。 |
| `glyphs` / `config` | 字形处理计数、字符集与有效配置。 |
| `resources` | timer、widget 等资源状态。 |
| `git-changes` | 工作树相对 HEAD/空树的计数、读取次数及采样参数。 |
| `selection-copy` / `copy-stats` | 镜像构建/降级、`other-wrapper`、复制模式/字数/耗时及最近失败。 |

没有活动会话时返回 `no active session`；宿主没有命令注册能力时不注册。诊断并不验证所有外部插件或服务是否正常。

## 实现与验证

显示诊断由 `src/diagnostics.ts` 装配。现有 appearance/host-surface 与 PTY 覆盖相应行为；执行范围见 [VALIDATION](../../VALIDATION.md)。
