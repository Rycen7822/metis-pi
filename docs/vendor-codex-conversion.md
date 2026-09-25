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

## 维护边界

- [UPSTREAM.md](../vendor/pi-codex-conversion/UPSTREAM.md)：精确来源/commit、载荷裁剪与升级步骤。
- [PATCHES.md](../vendor/pi-codex-conversion/PATCHES.md)：本地补丁契约，包括 Pi 0.86/0.87 transcript、回放、工具放置与 Notebook 共享捕获。
- [开发说明](development.md)：构建和检查命令；`patches/local.patch` 由脚本生成，不手改 `dist/`。
- `dist/`、`vendor/`、`code-mode/`、原生工具目录、`changelog.js` 和 `package.json` 的相对位置参与运行时资源定位，不可只因目录较多就移动或删除。

当前只保留 **linux-x64** 原生工具；语音 helper 被裁剪，依赖这些 helper 的语音功能不可用。其它平台需补齐载荷并验证。后台 shell 面板在 fullscreen 模式支持左键单击展开、再次单击折叠，与 `alt+w` 共用状态；普通终端模式继续使用快捷键。拖动和滚轮不触发折叠。默认快捷键 `alt+q` 可能与 Pi 冲突，可在 vendor 配置中改 `ui.backgroundShellPrevShortcut`。

转换层的发布与更新由 metis-pi 管理：已移除上游 npm 版本查询、比较和本地 checkout 落后提示，不会在启动时检查上游更新。保留上游版本号仅用于记录来源，手动同步上游时必须保留本地补丁。正常请求、prewarm、压缩、回放和代理必须共同验证；公开 facade、原生 ABI 和惰性加载不能仅靠静态不可达分析删除。真实服务端与可选运行时的验证范围见 [VALIDATION](../VALIDATION.md)。
