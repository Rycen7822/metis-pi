# 开发与验证

## 环境与常用命令

开发依赖与锁文件固定 Pi 1.4.0；Node 和原生资产要求见[兼容性](compatibility.md)。使用完整 checkout 与根工具链，不在 `src/` 内另装依赖。

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run prepare:subagents
```

Python 子代理运行核心使用标准库；测试另需 [requirements.txt](https://github.com/Rycen7822/metis-pi/blob/main/test/subagents/requirements.txt) 中的 pytest 9、xdist 和 schema 校验依赖。

| 命令 | 范围 |
| --- | --- |
| `npm run check` / `check:test` | 项目 / 测试 TS 类型，增量缓存位于 `.work/tsc/`。 |
| `npm test` / `test:fast` | `test/` 下 Node 测试及 Ask Vitest / core 规则与渲染原语。 |
| `npm run test:host` / `test:protocol` | 宿主接线与包内容 / 请求、回放、压缩和历史编辑。 |
| `npm run test:io` / `test:resource` | 文件、Git、归档 / 进程、锁、计时器、缓存和传输。 |
| `npm run test:lsp` / `test:ask-user-question` / `test:chrome` | LSP / 结构化提问 / 跨层界面、布局和复制。 |
| `npm run build:plugins` / `test:plugins` | Web bundle 与 MCP CLI / Web 共置测试。 |
| `npm run test:subagents` | Python Runtime、IPC、账本与继承；4 个 worker 按文件分配。 |
| `npm run verify` | 项目与测试类型、全部测试和实际 pack 文件清单。 |
| `npm run test:pty:strict` | 真实 Pi/tmux 的 E1–E4、E6；`test:pty` 同样要求完整执行。 |
| `npm run preview` | 生产渲染器生成 `docs/preview.html`、`transcript.ansi`、`transcript.txt`，不进 Git。 |
| `node scripts/copy-perf.mjs` | 渲染与文本提取成本，不测系统剪贴板延迟。 |

先跑改动附近的已有检查；跨模块变化运行 verify，终端交互变化增加 PTY。文档核对当前事实、链接和交付内容，不因文档改写补跑实现全套。

## 检查与 CI

- core 核对规则与渲染原语，contract 使用真实 Pi API，protocol 检查最终请求与历史，IO/resource 检查持久化、损坏恢复和资源释放。
- 夹具只准备输入，预期来自独立合同；及时清理临时目录、进程、计时器、网络钩子和包装。一次性诊断和验收放 `.work/`。
- pytest 使用原生 `unittest.subTest` 支持；`npm run test:subagents -- -n 0` 可串行排查顺序依赖。
- 严格 PTY 需要 Pi、tmux，E1 还需 Git；journey 使用隔离目录、离线 provider 和剪贴板 sink。`-- --journey=E3` 可单跑，缺依赖或未完成操作算失败。

| Journey | 验证 |
| --- | --- |
| E1 / E2 | Git footer / bash 执行和后续请求。 |
| E3 / E4 | 思考手势 / 复制、草稿和实际提交。 |
| E6 | 多 skill 补全、payload 和折叠。 |

CI 在 Ubuntu / Windows 的 Pi 1.4.0 基线上运行 verify；Linux 另跑 tmux/严格 PTY，并由独立 job 重建 Rust 搜索引擎、核对二进制与单元检查。功能分支若已有同 SHA、开放可合并的 PR，会跳过重复 push 全测；状态未知仍完整执行。同一 PR 新提交取消旧运行，main/tag/手动运行各自分组。

CI verify 使用 Node compile cache，进程和配置隔离保留。包检查由 `test/package.test.mjs` 调用 `npm pack --dry-run --json --ignore-scripts`，不把未实际运行的安装当验证。

## 源码与交付

模块所有权见[架构](architecture.md)。运行和测试消费同一 TS 模块，导入显式写 `.ts`；共享类型配置位于 `config/typescript/`，Ask 配置位于 `config/vitest/`，Web/Recall 保留各自类型入口并继承共享规则。

根 manifest 管理构建依赖。`scripts/build-web-access.mjs` 构建两个 Web bundle；子代理 `prepack` 从 Python schema 生成工具目录载荷。

发布包含运行时 TS、Web bundle、Python/JS 子代理核心、shell WASM、Linux / Windows x64 PTY helper 与搜索共享库、主题、skills 和许可。测试、构建工具及 Rust 源码保留在 Git。发布范围变化时，实际打包、解包核对入口、动态资源、二进制与执行权限；安装使用随包资产，不在用户目录构建。

PTY helper 的测试与构建：

```bash
cargo test --manifest-path native/tools/Cargo.toml --locked --workspace
node native/tools/build-linux-x64.mjs build
node native/tools/build-linux-x64.mjs verify
```

Linux helper 构建需要 Rust musl target、`musl-gcc`、`readelf` 与已缓存锁定依赖。Windows 使用 `node native/tools/build-win32-x64.mjs build`，需要 Rust MSVC target、Visual Studio C++ Build Tools 和 Windows SDK；`verify` 使用内置 PE 读取器。Windows 交叉构建环境变量见该脚本。`npm run verify:native-assets` 核对两平台的源码、资产及许可字节，再检查当前平台 ABI；不编译 Rust。安装包中的 manifest 本身不证明源码匹配。来源和许可见 [执行来源](provenance/execution/README.md)、[condense LICENSE](provenance/condense/LICENSE)及根 [NOTICE](../NOTICE)。

本地安装用 `pi install .`，更新用 `pi update --extensions`；用隔离 profile 验证实际发现和执行，不以直接导入源码替代安装验收。推送、发布和修改个人安装按当次授权执行。
