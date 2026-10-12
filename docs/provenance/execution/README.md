# 执行模块来源与维护

本项目自行维护 `src/execution` 与 `extensions/execution.ts`，根 manifest 管理依赖、版本和发布。当前职责见 [架构](../../architecture.md)，工具用法见 [执行工具](../../execution.md)。

| 来源 | 基线 | 许可 |
| --- | --- | --- |
| IgorWarzocha/howaboua-pi-stuff，packages/pi-codex-conversion | npm 3.0.34；`b4e228e049b7934a4350a9d9f14eaba6f9f59796` | MIT，[完整许可](LICENSE)。 |
| OpenAI Codex PTY / 图片工具 | `b545c94041017d000e2c8b2f6272705d21b85dfb`；对应 crates 的 UPSTREAM 记录 | Apache-2.0，[根许可](../../../LICENSE-APACHE-2.0)。 |
| shell parser | [vendor/tree-sitter-bash 来源与许可](../../../vendor/tree-sitter-bash/UPSTREAM) | 同目录 LICENSE。 |

## 保留的本地差异

- 进程/图片工具使用 Pi deferred 注册；Pi 持有工具选择、权限、provider、OAuth 和 JS codemode。
- 进程会话使用 NDJSON 拉取协议，原生 helper 持有增量输出与 exited/closed 状态；保留增量 UTF-8、交互输入、取消、输出归档和关闭，未关闭流或丢失保留数据会记录归档不完整，随包 helper 以绝对路径解析。
- Rust 工作区只构建随包的两个 helper，不发布独立库。图片 helper 验证并保留 original 字节或将 GIF 转为 PNG，不持有 provider 缩放策略或进程缓存。
- 图片描述使用 Pi 注册表与认证；detail 按调用/序号恢复，original 字节保存到会话 blobs，分叉保留来源身份。
- Pi edit/write 的 then_run 使用共享路径队列、修改快照和版本回执；命令走 native bash，输出先归档再截断。
- condense 对 Pi nested 事件归档并传播保护/失败状态；OCC 与远端检查点发布按同一次压缩请求的所有权协作。

随包内容为 TS、WASM 与 Linux x64 PTY/图片可执行文件；native 源码留在 Git，安装不编译或下载执行 host。MIT 及 Apache 归属同时见 [NOTICE](../../../NOTICE)。

Linux x64 helper 使用 musl 静态链接，不依赖宿主 GLIBC 版本。`native/tools/build-linux-x64.mjs` 管理锁定依赖的构建和核验，`assets/native-tools/linux-x64-manifest.json` 记录源码、工具链、静态 ABI 与随包字节 SHA256。构建环境和核验范围见 [开发说明](../../development.md)，musl 的版权与许可记录见 [musl-NOTICES](musl-NOTICES)。静态 ABI 检查不等于已在每种发行版运行验证。

## 更新

比较上游变化与当前职责，仅移植仍有用途的修复，不覆盖同步旧 conversion 包。保留取消、输出归档、图片语义和 Pi 工具契约；执行附近测试及类型检查，涉及终端或载荷时增加 PTY/隔离安装验证，见 [开发说明](../../development.md)。

当前差异在本页改写，产品变化写根 CHANGELOG；完整上游历史和退役实现留在 Git，不随包复制历史 changelog 或累计 patch。
