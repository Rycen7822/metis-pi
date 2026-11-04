# 开发与验证

## 环境与常用命令

根依赖/lock 固定 Pi 1.5.0，平台见[兼容性](compatibility.md)。用完整 checkout 与根工具链，不在 `src/` 另装依赖；禁用 bin links，检查调用 TypeScript 实体入口，PTY 使用同版 SDK 的真实 CLI。

```bash
npm ci --ignore-scripts --bin-links=false --no-audit --no-fund
npm run prepare:subagents
```

子代理运行核心仅用 Python 标准库；测试另需 [requirements.txt](https://github.com/Rycen7822/metis-pi/blob/main/test/subagents/requirements.txt) 的 pytest 9、xdist 和 schema 依赖。

| 命令 | 范围 |
| --- | --- |
| `npm run check` / `check:test` | 项目 / 测试 TS 类型；增量缓存 `.work/tsc/`。 |
| `npm test` / `test:fast` | Node + Ask Vitest / core 规则与渲染。 |
| `npm run test:host` / `test:protocol` | 宿主/包内容 / 请求、回放、压缩、历史编辑。 |
| `npm run test:io` / `test:resource` | 文件/Git/归档 / 进程、锁、timer、缓存、传输。 |
| `npm run test:lsp` / `test:ask-user-question` / `test:chrome` | LSP / 问卷 / 界面、布局、复制。 |
| `npm run build:plugins` / `test:plugins` | Web bundle、MCP CLI / Web 共置测试。 |
| `npm run test:subagents` | Python Runtime、IPC、账本、继承；4 worker 按文件分配。 |
| `npm run verify` | 类型、全部测试与实际 pack 清单。 |
| `npm run test:pty:strict` / `test:pty` | 真实 Pi/tmux 的 E1–E4、E6，均要求完整执行。 |
| `npm run preview` | 生产 renderer 生成未跟踪的 `docs/preview.html`、`transcript.ansi/.txt`。 |
| `node scripts/copy-perf.mjs` | 渲染/提取成本，不测系统剪贴板。 |

先跑最近已有检查，跨模块变化跑 verify，终端变化加 PTY；纯文档核对事实、链接、交付，不补跑产品全套。

## 检查与 CI

- core 测规则/渲染，contract 接真实 Pi API，protocol 测最终请求/历史，IO/resource 测持久化、损坏恢复、释放。
- 预期来自独立合同；清理夹具目录、进程、timer、网络钩子和包装，一次性诊断放 `.work/`。
- pytest 支持 `unittest.subTest`；`npm run test:subagents -- -n 0` 可查顺序依赖。
- PTY 需 Pi/tmux，E1 另需 Git；隔离目录/离线 provider/剪贴板 sink，`-- --journey=E3` 单跑。缺依赖或操作未完成均失败。

| Journey | 验证 |
| --- | --- |
| E1 / E2 | Git footer / bash 与后续请求。 |
| E3 / E4 | 思考手势 / 复制、草稿、实际提交。 |
| E6 | 多 skill 补全、payload、折叠。 |

CI 在 Ubuntu/Windows 的 Pi 1.5.0 上跑 verify；Linux 加严格 tmux/PTY，独立 job 重建搜索引擎并核对二进制/单元检查。功能分支已有同 SHA、开放且可合并 PR 时跳过重复 push 全测，状态未知仍跑；同 PR 新提交取消旧运行，main/tag/手动各自分组。Node compile cache 不改变进程/配置隔离；包检查实际执行 `npm pack --dry-run --json --ignore-scripts`，不等同安装验证。

## Pi SDK 源码补丁

[`sdk-patches/pi-1.5.0/`](../sdk-patches/pi-1.5.0/README.md)提供构建、CPU/历史内存补丁及实体依赖准备工具。仅显式重建并另行安装自定义 SDK 后生效；Metis 安装、postinstall、`/reload` 不自动打补丁。源码验证与用户安装分开，当前进程不会随构建自动切换。

## 源码与交付

[架构](architecture.md)列出 owner。运行/测试共用 TS，显式 `.ts` 导入；类型配置归 `config/typescript/`，Ask 用 `config/vitest/`，Web/Recall 保留入口并继承共享规则。

根 manifest 管构建依赖；`scripts/build-web-access.mjs` 构建两个 Web bundle，子代理 prepack 从 Python schema 生成工具目录。安装包含运行时 TS、Web bundle、Python/JS 核心、shell WASM、两平台 x64 PTY/搜索资产、主题、skills、许可与不自动执行的 SDK 补丁；测试/构建工具/Rust 源码留在 Git。

发布范围变化须实际打包/解包检查入口、动态资源、二进制与执行权限；用户安装使用随包资产，不现场构建。

```bash
cargo test --manifest-path native/tools/Cargo.toml --locked --workspace
node native/tools/build-linux-x64.mjs build
node native/tools/build-linux-x64.mjs verify
```

Linux helper 需 Rust musl target、`musl-gcc`、`readelf` 及缓存的锁定依赖；Windows 用 `node native/tools/build-win32-x64.mjs build`，需 MSVC target、VS C++ Build Tools、Windows SDK，交叉构建变量见脚本，verify 用内置 PE 读取器。`npm run verify:native-assets` 核对两平台源码/资产/许可字节和当前 ABI，不编译；manifest 本身不证明匹配。来源见[执行](provenance/execution/README.md)、[condense 许可](provenance/condense/LICENSE)、[NOTICE](../NOTICE)。

本地装 `pi install .`，更新用 `pi update --extensions`；用隔离 profile 验证实际发现/执行，不用直接导入代替安装验收。push、发布、个人安装须当次授权。
