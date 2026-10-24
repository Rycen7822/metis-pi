# 执行模块来源

Metis 维护 `src/execution/` 与 `extensions/execution.ts`，依赖和发布由根 manifest 管理。职责见[架构](../../architecture.md)，用法见[执行工具](../../execution.md)。

| 来源 | 基线 | 许可 |
| --- | --- | --- |
| IgorWarzocha/howaboua-pi-stuff，packages/pi-codex-conversion | npm 3.0.34；`b4e228e049b7934a4350a9d9f14eaba6f9f59796` | [MIT](LICENSE) |
| OpenAI Codex PTY 工具 | `b545c94041017d000e2c8b2f6272705d21b85dfb`，各 crate 的 UPSTREAM | [Apache-2.0](../../../LICENSE-APACHE-2.0) |
| shell parser | [vendor/tree-sitter-bash/UPSTREAM](../../../vendor/tree-sitter-bash/UPSTREAM) | 同目录 LICENSE |

本地实现提供 deferred PTY 工具、NDJSON 增量输出/退出/关闭协议、输出归档与 Action Fusion，使用 Pi 的权限、认证、工具事件和 codemode。Rust 工作区构建 `exec_bridge`；随包交付 TS、WASM、Linux x64 静态 helper 与 Windows x64 EXE，源码留在 Git。

`native/tools/build-{linux,win32}-x64.mjs` 分别管理 Linux 静态 ELF 和 Windows 静态 CRT PE 构建与 ABI 核验；manifest 记录源码输入、工具链及随包字节。环境与检查范围见[开发说明](../../development.md)，musl 归属见 [musl-NOTICES](musl-NOTICES)，其余归属见根 [NOTICE](../../../NOTICE)。更新需保留取消、归档和 Pi 工具契约，并执行相关检查。
