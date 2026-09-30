# Codex 模块

`src/codex/` 是 metis-pi 直接维护的模块，来源基于 `@howaboua/pi-codex-conversion` **3.0.34**。Pi 从 `src/codex/extension.ts` 加载 provider、执行工具和上下文能力；显示层只对明确属于本包的工具行做适配。

## 使用与配置

通过 `/codex [tab]` 管理转换层设置，配置存于 `pi-codex-conversion.json`，独立于 `metis-pi.json`。已有独立 codex-conversion 安装应先禁用或移除，避免同名工具和命令重复注册。

Codex 浏览器/设备码登录与凭据刷新由 Pi 原生 provider 管理；转换层不再额外申请 connector 权限。模型目录同样跟随 Pi，转换层保留自己的请求适配与执行工具。

| 执行模式 | 主要工具 |
| --- | --- |
| normal | `exec_command`、`write_stdin`、`apply_patch`、`view_image` 等原生工具。 |
| code | 通过 `exec` / `wait` 执行程序，并在程序中调用工具。 |

具体注册集合受 provider 和模式配置影响。history/notes、上下文窗口及压缩组合另有设置；与自动精简的配合见 [condense](features/condense.md)，修改后执行命令见 [Action Fusion](features/action-fusion.md)。Code Mode 的 V8 运行时按需加载。

后台 shell 面板使用可配置的 `alt+w` / `alt+q` / `alt+e` / `alt+r`。fullscreen 下单击展开/折叠与快捷键共享状态，拖动和滚轮不切换；regular 模式使用快捷键。默认 `alt+q` 可能与 Pi 冲突，可调整 `ui.backgroundShellPrevShortcut`。

## 输出与资源保留

| 行为 | 边界 |
| --- | --- |
| exec 输出预算 | 非 TTY 默认 256 Mi 字符、TTY 默认 1 Mi 字符；超过 1 Mi 字符的缓冲转入私有临时 UTF-16 环形文件，磁盘仍受同一额度限制。 |
| 结果读取 | 只读取本次所需尾部；观察退出并交付结果后释放完整缓冲，保留有界完成回放。未读退出结果留待后续 write_stdin 或关闭。 |
| 取消 | 取消等待不会误杀进程或吞掉未读输出；取消执行/关闭会清理相关资源。 |
| 存储失败 | 创建/写入失败退回原内存额度；不可恢复的读取错误明确失败。大结果请求仍可能造成瞬时内存峰值，tmpfs 仍占系统 RAM，强制杀进程可能留下临时文件。 |
| 原文证据 | 执行归档、融合 journal 和 condense blobs 的寿命独立于显示环形缓冲；恢复与清理边界见功能页。 |

WebSocket 成功路径不预先生成无用的 SSE 请求体；实际使用 SSE 或回退时才准备。请求快照避免重复持有同源历史，真实 replay 仍返回独立副本。该行为不缩减既有输出保留额度。

## 请求契约

- live/prewarm 共用公共准备；普通预热不消费待处理窗口、不执行最终 replay 注入或 prompt 捕获。
- history/notes 的字段规则共享，Remote、Tree 等模式的 wire 与持久化差异分别保留，每个请求使用自己的 schema 副本。
- 正常请求、预热、压缩、回放和代理传输共同接受兼容性验证。模块所有权见 [架构](architecture.md)，Pi 会话变化见 [兼容性](compatibility.md)。

## 安装、平台与维护

运行实现直接采用 TS，本地/Git/npm 安装免构建。根 manifest 统一版本和依赖；第三方 tokenizer/WASM 在 `vendor/`，Rust 源码在 `native/`，随包执行文件在 `assets/native-tools/`。旧 conversion 目录和转导出入口已移除；配置中旧入口的白名单和排除规则应使用新路径（排除项为 `-src/codex/extension.ts`），外部直接导入也需更新。配置文件和 host 缓存路径保持不变。

当前只内置 **linux-x64** 原生工具，语音功能及其源码已移除。其他平台需补齐并验证载荷。转换层不在启动时查询上游 npm 版本，随 metis-pi 一起更新；Pi 0.87.1 的扩展更新命令为 `pi update --extensions`。

上游更新采用独立分支选择性移植，源码/Git 历史保存实现分歧，累计 patch 与覆盖式 sync 已退休：

- [UPSTREAM](provenance/codex-conversion/UPSTREAM.md)：固定来源、许可、载荷范围与升级步骤。
- [PATCHES](provenance/codex-conversion/PATCHES.md)：本地行为修改。
- [开发说明](development.md)：类型、安装与发布检查。
- [VALIDATION](../VALIDATION.md)：真实后端、下载器与服务端的已测/未测范围。
