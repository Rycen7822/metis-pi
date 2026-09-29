# 兼容性与已知限制

## 版本与验证范围

最低支持 Pi **0.87.0**、Node **22.19.0**；开发类型和组件契约固定于 Pi 0.87.0，最近实际 CLI 安装、Git 更新和严格 PTY 使用 **0.87.1**。transcript 和 constrained sampling 复用宿主实现；旧 Context、切片与旧会话记录仍受兼容包装保护。具体环境、成功结果及未覆盖项见 [VALIDATION](../VALIDATION.md)，不保证所有未来内部 UI 改动都兼容。

本包包含显示适配以及独立的任务、输入、上下文和执行功能。各入口的副作用见 [架构](architecture.md)；`metis-pi.json.enabled` 只控制显示层，禁用其他入口见 [配置参考](configuration.md)。

## 工具行适配

`src/adapter.ts` 装饰 ToolExecutionComponent 的三个 renderer/shell selector 和该组件自身的 `render`，保留原执行与存储结果。

| 守卫 | 行为 |
| --- | --- |
| 宿主形状 | selector 源码与 render 关键标记必须匹配；不匹配时退避并报告原因。 |
| 工具来源 | Pi 内建工具使用 builtin 身份；本包 apply_patch/exec_command 使用 conversion 的精确入口路径。未知或第三方来源不接管。 |
| 安装身份 | 原型标记防止重复安装，每次使用核对包装器仍归本扩展。 |
| 恢复 | 保留构造时的 stock 子树；卸载恢复自己仍拥有的方法，不覆盖后来者。 |
| 渲染失败 | 单行回退原生显示；图片顺序、高度和原生鼠标路径保留。 |

`exec_command` 只适配命令 call 的显示，保留外层 shell 和结果布局。终端控制序列的清理发生在显示副本，存储结果不变。详细效果见 [转录显示](features/transcript.md)。

## 其他界面与第三方插件

- composer、footer、Working 和 header 使用宿主 UI 能力；自定义 editor 已被占用或能力缺失时按组件规则退避。
- fullscreen 的布局/历史窗口、选区复制和 skill 显示仍依赖内部组件结构。守卫只能覆盖已知契约，任意后装插件若改写同一实例或方法，需要查看 `/codex-ui` 的实际状态。
- 第三方工具定义、执行结果与 renderer 保持；用户主动选择本包主题时，主题颜色仍可能影响第三方输出。
- 独立 todo、condense 或 conversion 包可能产生同名入口；按功能页迁移或过滤，不能把显示层来源守卫当作工具注册去重。
- 复制与鼠标能力随 fullscreen/regular 模式、终端协议和字体变化，分别见 [复制](features/selection-copy.md) 与 [全屏布局](features/fullscreen-layout.md)。本包不实现 Codex 审批语义。

## 请求与会话兼容

| 宿主契约 | 本地处理 |
| --- | --- |
| Pi 0.86.1 transcript | prompt 和工具定义进入 transcript 的 system 消息；conversion 的 `providers/transcript.ts` 保持正常请求、预热与回放的共同语义。 |
| Pi 0.86.1 skill MouseRegion | fold/label 跟随有界组件结构；认领 press 后处理 click，保留宿主渲染和正文。 |
| Pi 0.87 context_edit | 从 SessionManager 的有效投影重建；checkpoint 之前已吸收的编辑与之后改写保留内容的编辑分别判断。失效窗口明确拒绝，新的压缩从编辑后的内容重建。 |
| retain-none checkpoint | 兼容旧宿主的 null 和 0.87 的 checkpoint 自身 ID；未知 ID、缺失字段等不当作空窗口。 |

无法解析 `firstKeptEntryId` 时，replay 报错，native compaction 在摘要请求前取消，避免发送旧 opaque 窗口。Pi <0.87 的会话没有 context_edit 时保留原请求前缀。具体保护与主动 OCC 的后端范围见 [condense](features/condense.md)。

## 平台与实测限制

- 当前仓库内置的原生工具载荷为 **linux-x64**；其他平台需要对应载荷及安装验证，不能仅根据纯 TypeScript 能加载推断可用。
- 真实 Pi、tmux 和离线 provider 验证了安装/加载及终端交互；这些证据不覆盖所有真实服务端、付费模型、第三方插件组合或终端图片协议。
- 字体、宽度和颜色能力会影响外观；逻辑选区的测试证据与系统剪贴板的实际写入/回读证据分别记录。
- V8 后端和下载器的实测范围以 VALIDATION 为准；源代码/包检查不能替代后端运行证据。

## 来源定位

最初的双槽工具组件契约来自 `earendil-works/pi` v0.85.1 的 `tool-execution.ts`（blob `5355a3637aad9df5871ac907b680378ffd67b677`）、`source-info.ts` 与 TUI `text.ts`。后续核对使用 v0.86.1 (`13cbf77df2396303013a41646bcfa77b4271ae56`) 和 v0.87.0 (`16787ad5`)。

工具行视觉参考包括 `openai/codex` 的 exec snapshot（blob `eb47a610cc5d54ede53f8e5faee8dd5fb27578b4`）以及提交 `94697375cb9d2aa8ae74d61957c6b396819bec94` 的 `diff_render.rs`；本地格式化器以 TypeScript 实现。vendor 的精确来源和本地分歧见 [转换层说明](vendor-codex-conversion.md)。
