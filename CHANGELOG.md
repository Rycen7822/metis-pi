# Changelog

仅保留版本差异摘要。当前行为见 [功能手册](docs/README.md)，验证结果见 [VALIDATION](VALIDATION.md)。此前的详细发布/排查记录可用 `git show 4b1319a:CHANGELOG.md` 查看。

## Unreleased

- 新增 dynamic-agents：外置 JSON 按 provider/模型正选、反选及跨 provider 模型简称匹配全局指令；下一次 agent run 生效，只替换请求上下文，保留源文件与历史记录；支持状态查询、回退和 Codex 预热协调。

- condense 统一摘要输入预算，保留关键首尾并约束大型参数；增加完整参数/历史 entry 分页回读、成功大写入组的确定性精简，以及完整投影净缩减检查。OCC 新保护结构展平并保留历史引用，收紧工作资格，补充拒绝原因；维持现有请求额度，并修复容量估算错误扣除保留的 system/工具定义开销。

- 主动 OCC 执行时显示独立的 `OCC: compacting…` 状态栏标识，结束后保留最近一次结果，并在 reload 后恢复；新增默认开启的 `showOccStatusLine` 开关，可通过 `/pruner settings` 即时切换。

- OCC 增加接近 auto-compact 阈值时的缓冲与滞回、压缩后整体容量余量检查；等待期间保留原文归档和 goal 正常续跑，关闭 auto-compact 时不让位。

- 修复容量压缩取消/早期失败后 OCC 立即重启，以及 condense 发布后旧 usage 引发紧接的阈值摘要；保留新用量高占用与真实 overflow 的容量救援。

- Action Fusion 使用统一扩展开关：排除 `extensions/action-fusion.ts` 同时关闭原生 edit/write、转换层 apply_patch 和 Code/Notebook 融合入口，保留普通工具；修正文档中的包内过滤路径。

- 增加可选受控 OCC：共享局部/全局缓冲与保持、目标和证据原文保护、有效投影校验及 goal 安全续跑；增加证据目录。修复失败状态丢失、分页读取被替换和输出去重混淆执行元数据。

- 固定完整的 Pi 开发类型依赖并提交去重后的 npm 锁文件；CI 与开发验证改用 `npm ci`，避免浮动 peer 版本及重复 TUI 实例导致构建和宿主检查失败。

- 增加 Action Fusion：Pi 原生 edit/write、普通 apply_patch 的可选 `then_run`，以及 Code/Notebook 的 `apply_patch_then_run`。保留修改与命令独立状态、命令前 diff、取消/超时及完整日志；嵌套回执独立于显示 trace 持久化，可由 condense 索引和分页恢复。

- condense 在最终回复边界先精简成功 build/test 输出，再按现有 `minBatchChars` 判断模型调用；程序保留恢复引用，停止自动二次链摘要。Codex 大输出在显示截断前写入会话归档，导入原生 bash 完整日志；预热共用压缩投影，goal 动态计数移出系统前缀。

- 内置 pi-condense 2.11.0，沿用现有 `contextPrune`、`/pruner`、归档兼容性；已有外部恢复工具时跳过内置实例并提示迁移。`context_tree_query` 增加 UTF-8 分页、总返回预算和显式归档缺失错误；摘要用量单列展示，不重复计入 footer 的标准会话 usage。

- 修复细竖线假光标遮住光标下方字符：改用终端真实竖线光标，去掉宿主字符上的反色但不替换字符；保留输入法定位、宽字符占位及草稿内容，卸载时恢复终端光标形状。
- 将模型 id、推理深度、provider 与上下文占用从输入框下沿的 metadata widget 移至 footer，与路径、会话 I/O、cache 按顺序排布；窄屏按字段换行，不再使用同底色 widget。
- 移除右侧 footer 的重复 Codex 额度及其独立 app-server 查询、轮询、配置和诊断入口；不再在非 Codex 模型下显示历史额度，左侧 Codex adapter 自带状态行不受影响。
- 后台 shell 面板支持左键单击展开、再次单击折叠（fullscreen 模式），与 `alt+w` 共用折叠状态；保留原有会话切换/关闭快捷键，拖动、滚轮和其他鼠标键不触发折叠。
- 内置 `exec_command` 的普通命令预览复用原生 `bash` 的宽度感知组件和 Codex 语法高亮：先换行再按屏幕行折叠，不再把单行 `&&` / `;` 命令链截成 100 字符。折叠/展开、窗口缩放与多行 heredoc 共用同一布局；探索分组、后台会话、退出状态及第三方工具不变。

- 修复原生 `edit` 多处修改时混合位数行号错位：正确解析 Pi 补空格的行号栏，保留正文缩进、开头数字及空行；真实宿主测试覆盖同一 diff 中一至四位行号。

- 修复正常 Git 安装（无本地 Pi peer 依赖）时，Pi 的独立扩展模块上下文各持一份 `apply_patch` 状态，导致 diff 回退为旧样式的问题。执行快照和 compact 控制器按实际模块 URL 共享，保留会话清理和不同安装目录隔离。

- TUI 运行期间精确过滤 pi-web-access 的已知动态工具兼容性回退警告，防止子代理加载扩展时污染输入框；保留其他警告、错误及正常通知，退出时恢复。
- 内置 `apply_patch` 的默认折叠预览与展开 diff 均接入与 `edit` 相同的 Codex 整行底色、行号和换行布局，修复仅展开生效的遗漏；折叠预算按换行后的屏幕行跨文件计算，三位及以上行号正确参与宽度计算。复用转换层唯一的执行前快照与摘要偏好，保留失败诊断和第三方工具所有权。
- footer 的 `+A -D` 改为当前工作树相对 HEAD 的未提交改动：暂存 + 未暂存从工作树侧计一次，另计未跟踪非忽略文本文件；启动时已存在的 WIP 立即显示，commit/撤销后数字随之下降，反复刷新不再累积。删除了旧的会话累计 churn、内容 blob 私有对象库、commit 折算与 observed 快照等机制；无 HEAD 仓库改与空树比较，已暂存新文件不再遗漏。
- 适配 Pi 0.87.0：开发依赖、CI 与真实宿主检查目标更新；运行期不静态导入 0.87 专有 API，旧宿主请求前缀与旧会话行为保留。
- vendored Codex 在重建压缩输入和回放片段前应用 `context_edit` 投影，并由同一 `inspectCheckpointWindow` 判定 checkpoint 边界与窗口可复用性：已吸收的编辑保持可复用，后续改写 kept 内容的编辑不会被旧窗口复活（普通回放显式失败、再次压缩从编辑后上下文重建）。无法解析的 `firstKeptEntryId`（字段缺失、显式 `undefined`、未知/后置 id）不再退化为空保留窗口：在任何摘要请求前就明确取消，native 与 portable 请求均不会发出；只有 0.87 的 checkpoint 自身 id 与 0.86 的 `null` 视为零保留。
- 外部 `agent-stuff` `/btw` 的 0.87 种子历史补丁保存在 `.work/pi087/btw-fix`（不属于本包发布内容，未改动已安装缓存）。
- vendor 维护脚本修正文件条目复制、从仓库根重放补丁并保留原生工具可执行位，`vendor:sync` 可在 pristine 3.0.34 上完整重放。
- 显示消息保留稳定身份，删除结束时的别名、状态复制和重复内容解析；goal 的状态、计时与用量交由独立核心管理，宿主入口负责 I/O。
- 自有/vendor 配置校验、15 个设置开关、todo 参数/更新状态与 Responses transcript 准备收拢为各自的单一契约；Notebook 捕获和载荷校验共用实现，清单与事务边界保留。
- DIM/背景共用 SGR 参数解析，修复 RGB/indexed/colon 颜色之后的复位遗漏和同一序列内的复位顺序；shell 物理行截断去掉冗余计数循环。
- 修正无效 `thinking.completed` 的回退提示；合并重复文档、删除已完成计划与独立审查报告，修正旧宿主/测试路径及失效的兼容性说明。

## 0.19.6

- 适配 Pi 0.86.1：Codex provider 同时接受旧式 Context 与 transcript；skill 标签适配 MouseRegion 嵌套；开发依赖与 marked 对齐宿主。
- 工具放置统一决策：删除/同名重声明使用完整当前工具表，纯新增保持就地锚点，新旧路径不重复声明或复活删除项。
- 压缩/回放共享模型能力和放置决策，切片保留中途 system 更新，tool-search ID 跨切片稳定；重建压缩请求同步顶层 tools。canonical 请求保留自身基线。
- 真实 provider 请求的协议、回放与最终压缩请求回归覆盖上述行为。维护说明见 [vendor 补丁](vendor/pi-codex-conversion/PATCHES.md)。

## 0.19.0–0.19.5

| 版本 | 改动 |
| --- | --- |
| 0.19.5 | todo 对外编号改为层级路径，新列表从 `#1` 开始，内部身份与显示编号分离。 |
| 0.19.4 | 修正完成任务的 turn 信号，已完成列表后添加任务默认开启新列表。 |
| 0.19.3 | footer 改动统计改为会话观察到的 churn，修复已有 WIP 内改动与撤销漏计。 |
| 0.19.2 | 多 skill 折叠标签显示全部名字。 |
| 0.19.1 | 重启时隐藏历史上已全部完成的 todo 面板。 |
| 0.19.0 | skill 条目支持点击展开/折叠，并保留修饰键选择行为。 |

## 更早版本

| 版本范围 | 主要演进 |
| --- | --- |
| 0.18.0–0.18.3 | 完善多 skill 菜单触发、删除占位提示、将多个 skill 合并折叠。 |
| 0.17.x | vendored Codex 转换层、多 skill 输入，以及 todo 面板交互调整。 |
| 0.16.0 | 独立 codex-todo 子插件和多入口布局。 |
| 0.12.0–0.15.x | 思考窥视窗、字形呈现、布局和输出显示改进。 |
| 0.10.0–0.11.0 | 持久 goal 与状态刷新。 |
| 0.9.x | 精确选区复制、有界历史窗口、性能和宿主显示修复。 |
| 0.8.x | 独立主界面 chrome、真实宿主指标与结束摘要。 |
| 0.1.0–0.7.0 | 从工具重注册迁移到有守卫的显示适配层；早期 Zentui 协同方案后被替代。 |
