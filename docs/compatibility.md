# 兼容性与已知限制

## 版本与验证范围

最低支持 Pi **0.99.1**、Node **22.19.0**；开发类型和当前交接验证固定于 Pi 0.99.1。provider、transcript 和 constrained sampling 使用 Pi 原生实现；特殊上下文已退役。安装、CLI 与终端交互的实际覆盖见 [VALIDATION](../VALIDATION.md)，不保证所有未来内部 UI 改动都兼容。

本包包含显示适配以及独立的任务、输入、上下文和执行功能。各入口的副作用见 [架构](architecture.md)；`metis-pi.json.enabled` 只控制显示层，禁用其他入口见 [配置参考](configuration.md)。

## 工具行适配

`src/adapter.ts` 装饰 ToolExecutionComponent 的三个 renderer/shell selector 和该组件自身的 `render`，保留原执行与存储结果。

| 守卫 | 行为 |
| --- | --- |
| 宿主形状 | selector 源码与 render 关键标记必须匹配；不匹配时退避并报告原因。 |
| 工具来源 | Pi 内建工具使用 builtin 身份；本包 exec_command 使用 execution 的精确入口路径。未知或第三方来源不接管。 |
| 安装身份 | 原型标记防止重复安装，每次使用核对包装器仍归本扩展。 |
| 恢复 | 保留构造时的 stock 子树；卸载恢复自己仍拥有的方法，不覆盖后来者。 |
| 渲染失败 | 单行回退原生显示；图片顺序、高度和原生鼠标路径保留。 |

`exec_command` 只适配命令 call 的显示，保留外层 shell 和结果布局。终端控制序列的清理发生在显示副本，存储结果不变。详细效果见 [转录显示](features/transcript.md)。

## 其他界面与第三方插件

- composer、footer、Working 和 header 使用宿主 UI 能力；自定义 editor 已被占用或能力缺失时按组件规则退避。
- fullscreen 的布局/历史窗口、选区复制和 skill 显示仍依赖内部组件结构。守卫只能覆盖已知契约，任意后装插件若改写同一实例或方法，需要查看 `/codex-ui` 的实际状态。
- 第三方工具定义、执行结果与 renderer 保持；用户主动选择本包主题时，主题颜色仍可能影响第三方输出。
- 独立 condense 或 conversion 包可能产生同名入口；按功能页迁移或过滤，不能把显示层来源守卫当作工具注册去重。
- 复制与鼠标能力随 fullscreen/regular 模式、终端协议和字体变化，分别见 [复制](features/selection-copy.md) 与 [全屏布局](features/fullscreen-layout.md)。本包不实现 Codex 审批语义。

## 请求与会话兼容

| 宿主契约 | 本地处理 |
| --- | --- |
| Pi 0.99.1 transcript / provider | 使用 Pi 原生目录、认证、请求和工具配对；没有转换层回放。 |
| Pi 原生 codemode | metis 普通工具按 exposure 注册；执行、权限和 nested 事件由 Pi 管道负责。 |
| Pi context_edit / ordinary compaction | condense 使用有效投影保留来源索引、精简保护与回读；OCC 由 condense 在 before_compact 准备。 |
| 旧特殊窗口 / opaque checkpoint | 不再解释；需要保留的用户文件先备份，使用升级前版本导出可读基线，见[旧数据说明](codex.md)。 |

扩展不自动改写用户设置或旧会话。嵌套证据未完成或归档失败时 OCC 取消，保留源历史。原生 codemode 通过 Pi 工具管道处理权限和完整结果归档。

## 平台与实测限制

- 当前仓库内置的原生工具载荷为 **linux-x64**；其他平台需要对应载荷及安装验证，不能仅根据纯 TypeScript 能加载推断可用。
- 真实 Pi、tmux 和离线 provider 验证了安装/加载及终端交互；这些证据不覆盖所有真实服务端、付费模型、第三方插件组合或终端图片协议。
- 字体、宽度和颜色能力会影响外观；逻辑选区的测试证据与系统剪贴板的实际写入/回读证据分别记录。
- 进程和图片 helper 的实测范围以 VALIDATION 为准；源代码/包检查不能替代后端运行证据。

## 来源定位

最初的双槽工具组件契约来自 `earendil-works/pi` v0.85.1 的 `tool-execution.ts`（blob `5355a3637aad9df5871ac907b680378ffd67b677`）、`source-info.ts` 与 TUI `text.ts`。后续核对使用 v0.86.1 (`13cbf77df2396303013a41646bcfa77b4271ae56`) 和 v0.99.1 (`16787ad5`)。

工具行视觉参考包括 `openai/codex` 的 exec snapshot（blob `eb47a610cc5d54ede53f8e5faee8dd5fb27578b4`）以及提交 `94697375cb9d2aa8ae74d61957c6b396819bec94` 的 `diff_render.rs`；本地格式化器以 TypeScript 实现。vendor 的精确来源和本地分歧见 [转换层说明](codex.md)。
