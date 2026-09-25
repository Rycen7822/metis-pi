# 内置 Codex 转换层

`vendor/pi-codex-conversion/` 基于 `@howaboua/pi-codex-conversion` **3.0.34**，Pi 直接加载其 `dist/index.js`。本仓库维护源码、构建产物和补丁，安装期不构建；`pi update` 更新本包时携带这些补丁，升级 vendored 上游则需显式同步。

## 能力与入口

具体注册项受模式配置影响，`vendor:smoke` 核对实际激活结果。

| 领域 | 能力 | 源码入口（相对 vendor 的 `src/`） |
| --- | --- | --- |
| Codex / Responses | provider、动态工具、代理传输 | `providers/` |
| code / notebook | `exec`、`wait`、`notebook` | `tools/code-mode/`、`tools/notebook-mode/` |
| 原生工具 | `exec_command`、`write_stdin`、`apply_patch`、`view_image` | `tools/exec/`、`tools/apply-patch/`、`tools/view-image/` |
| 上下文 | `new_context`、`get_context_remaining`、`history`、`notes`、压缩/回放 | `context-management/`、`adapter/compaction/`、`adapter/replay/` |
| 设置 | `/codex`、推理等级与工具显示 | `ui/settings/`、`adapter/activation/` |
| 装配 | 模式决策、注册、事件与运行生命周期 | `extension/`，决策由 `adapter/activation/runtime-plan.ts` 拥有 |

配置存于 `pi-codex-conversion.json`，与显示层的 `metis-pi.json` 分开。安装本包时应卸载或禁用独立 codex-conversion 包，避免同名工具和命令重复注册。

## 内存与输出保留

- `exec_command` 保持原有字符保留额度（非 TTY 默认 256 Mi 字符、TTY 默认 1 Mi 字符），不靠缩小额度丢弃输出。超过 1 Mi 字符的缓冲转入私有临时 UTF-16 环形文件；磁盘大小也受同一额度限制，工具只读取本次请求需要的尾部。
- 观察到退出并读取结果后立即释放完整缓冲，仅保留既有的有界完成回放。尚未读取的退出输出保留至后续 `write_stdin` 或关闭；取消等待不误杀进程或吞掉未读输出，取消执行与关闭清理临时文件及回调。
- 临时存储不可创建或写入时退回原有内存额度，以保持工具执行和输出语义；不可恢复的读取错误显式失败。很大的显式结果请求仍可能产生与结果大小成比例的瞬时内存。临时目录在 tmpfs 上时仍占系统 RAM，降低进程堆不等于消除存储成本；正常清理以外的强制杀进程可能留下私有临时文件。
- 成功的 WebSocket 请求不再提前序列化/压缩一份不会使用的 SSE 请求；只有实际使用 SSE（含回退）时才准备重试请求体。canonical history 的请求及重建视图以一次图快照保存，同源输入不重复复制，响应仍独立持有；校验只比较内容，不复制整份重放载荷，真正重放仍返回独立副本。

## 维护边界

- [UPSTREAM.md](../vendor/pi-codex-conversion/UPSTREAM.md)：精确来源/commit、载荷裁剪与升级步骤。
- [PATCHES.md](../vendor/pi-codex-conversion/PATCHES.md)：本地补丁契约，包括 Pi 0.86/0.87 transcript、回放、工具放置与 Notebook 共享捕获。
- [开发说明](development.md)：构建和检查命令；`patches/local.patch` 由脚本生成，不手改 `dist/`。
- `dist/`、`vendor/`、`code-mode/`、原生工具目录、`changelog.js` 和 `package.json` 的相对位置参与运行时资源定位，不可只因目录较多就移动或删除。

当前只保留 **linux-x64** 原生工具；语音 helper 被裁剪，依赖这些 helper 的语音功能不可用。其它平台需补齐载荷并验证。后台 shell 面板在 fullscreen 模式支持左键单击展开、再次单击折叠，与 `alt+w` 共用状态；普通终端模式继续使用快捷键。拖动和滚轮不触发折叠。默认快捷键 `alt+q` 可能与 Pi 冲突，可在 vendor 配置中改 `ui.backgroundShellPrevShortcut`。

转换层的发布与更新由 metis-pi 管理：已移除上游 npm 版本查询、比较和本地 checkout 落后提示，不会在启动时检查上游更新。保留上游版本号仅用于记录来源，手动同步上游时必须保留本地补丁。正常请求、prewarm、压缩、回放和代理必须共同验证；公开 facade、原生 ABI 和惰性加载不能仅靠静态不可达分析删除。真实服务端与可选运行时的验证范围见 [VALIDATION](../VALIDATION.md)。
