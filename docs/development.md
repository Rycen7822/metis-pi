# 开发与验证

## 环境与常用命令

根依赖和 lock 固定 Pi 1.5.0，平台见[兼容性](compatibility.md)。使用完整 checkout 和根工具链，依赖安装在根目录；禁用 bin links，检查调用 TypeScript 实体入口，PTY 使用同版 SDK 的真实 CLI。

```bash
npm ci --ignore-scripts --bin-links=false --no-audit --no-fund
npm run prepare:subagents
```

子代理运行核心只用 Python 标准库；测试另需 [requirements.txt](https://github.com/Rycen7822/metis-pi/blob/main/test/subagents/requirements.txt) 中的 pytest 9、xdist、schema 依赖。

| 命令 | 范围 |
| --- | --- |
| `npm run check` / `check:test` | 项目 / 测试 TS 类型；增量缓存 `.work/tsc/`。 |
| `npm test` / `test:fast` | Node + Ask Vitest / core 规则和渲染。 |
| `npm run test:host` / `test:protocol` | 宿主和包内容 / 请求、回放、压缩、历史编辑。 |
| `npm run test:io` / `test:resource` | 文件和 Git/归档 / 进程、锁、timer、缓存、传输。 |
| `npm run test:lsp` / `test:ask-user-question` / `test:chrome` | LSP / 问卷 / 界面、布局、复制。 |
| `npm run build:plugins` / `test:plugins` | Web bundle、MCP CLI / Web 共置测试。 |
| `npm run test:subagents` | Python Runtime、IPC、账本、继承；4 worker 按文件分。 |
| `npm run verify` | 类型、全部测试、实际 pack 清单。 |
| `npm run test:pty:strict` / `test:pty` | 真实 Pi/tmux 的 E1–E4、E6，都要完整执行。 |
| `npm run preview` | 生产 renderer 生成未跟踪的 `docs/preview.html`、`transcript.ansi/.txt`。 |
| `node scripts/copy-perf.mjs` | 渲染和提取成本；剪贴板行为另用 PTY 验收。 |

先运行最近的已有检查；跨模块改动跑 verify，终端改动加 PTY。纯文档改动核对事实、链接和交付即可。

## 检查与 CI

- core 测规则和渲染，contract 接真实 Pi API，protocol 测最终请求和历史，IO/resource 测持久化、损坏恢复、释放。
- 预期来自独立合同；夹具目录、进程、timer、网络钩子、包装每次清掉，一次性诊断放 `.work/`。
- pytest 支持 `unittest.subTest`；`npm run test:subagents -- -n 0` 可查顺序依赖。
- PTY 要 Pi/tmux，E1 另要 Git；隔离目录、离线 provider、剪贴板 sink，`-- --journey=E3` 单跑。缺依赖或没做完都算失败。

| Journey | 验证 |
| --- | --- |
| E1 / E2 | Git footer / bash 和后续请求。 |
| E3 / E4 | 思考手势 / 复制、草稿、实际提交。 |
| E6 | 多 skill 补全、payload、折叠。 |

CI 在 Ubuntu/Windows 的 Pi 1.5.0 上跑 verify；Linux 加严格 tmux/PTY，独立 job 重建搜索引擎并核对二进制和单元检查。功能分支已有同 SHA、开放且可合并 PR 时跳过重复 push 全测，状态未知照跑；同 PR 新提交取消旧运行，main/tag/手动各自分组。Node compile cache 保持进程和配置隔离；包检查实际跑 `npm pack --dry-run --json --ignore-scripts`，安装验收另做。

## Pi SDK 源码补丁

[`sdk-patches/pi-1.5.0/`](../sdk-patches/pi-1.5.0/README.md)放构建、CPU/历史内存补丁和实体依赖准备工具。只在显式重建并另行安装自定义 SDK 后生效；Metis 安装、postinstall、`/reload` 都不会应用它。源码验证和用户安装是两条线，当前进程跟随已安装的 SDK。

## 源码与交付

[架构](architecture.md)列 owner。运行和测试共用 TS，显式 `.ts` 导入；类型配置归 `config/typescript/`，Ask 用 `config/vitest/`，Web/Recall 保留入口并继承共享规则。

根 manifest 管构建依赖；`scripts/build-web-access.mjs` 构建两个 Web bundle，子代理 prepack 从 Python schema 生成工具目录。

安装带运行时 TS、Web bundle、Python/JS 核心、shell WASM、两平台 x64 PTY 和搜索资产、主题、skills、许可，以及手动应用的 SDK 补丁；测试、构建工具、Rust 源码留 Git。

发布范围变了，实际打包解包检查入口、动态资源、二进制和执行权限；用户安装用随包资产，构建只在开发机。

```bash
cargo test --manifest-path native/tools/Cargo.toml --locked --workspace
node native/tools/build-linux-x64.mjs build
node native/tools/build-linux-x64.mjs verify
```

Linux helper 要 Rust musl target、`musl-gcc`、`readelf` 和缓存的锁定依赖；Windows 用 `node native/tools/build-win32-x64.mjs build`，要 MSVC target、VS C++ Build Tools、Windows SDK，交叉构建变量见脚本，verify 用内置 PE 读取器。`npm run verify:native-assets` 核对两平台源码、资产、许可字节和当前 ABI，编译另跑；manifest 只是清单，匹配与否以核对面板为准。来源见[执行](provenance/execution/README.md)、[condense 许可](provenance/condense/LICENSE)、[NOTICE](../NOTICE)。

本地装 `pi install .`，更新用 `pi update --extensions`；用隔离 profile 验证实际发现和执行，直接导入只算冒烟。push、发布、个人安装每次都要当场授权。
