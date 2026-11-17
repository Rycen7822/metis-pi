# 开发与验证

从仓库根目录运行。版本与平台要求见[兼容性](compatibility.md)。普通开发使用随包的原生资产，不必从源码重建。

```bash
npm ci --ignore-scripts --bin-links=false --no-audit --no-fund
npm run prepare:pi-sdk
npm run prepare:subagents
```

`prepare:pi-sdk` 将仓库的 SDK 归档装入本项目的依赖，不更新个人 Pi。Python 测试的依赖见 [requirements.txt](https://github.com/Rycen7822/metis-pi/blob/main/test/subagents/requirements.txt)；子代理运行时只使用标准库。

## 选择检查

| 改动 | 检查 |
| --- | --- |
| TypeScript | `npm run check`、`npm run check:test` |
| 规则与渲染 | `npm run test:fast`、`npm run test:chrome` |
| 宿主、包内容与协议 | `npm run test:host`、`npm run test:protocol` |
| 存储与资源释放 | `npm run test:io`、`npm run test:resource` |
| 扩展和子代理 | `npm run test:lsp`、`npm run test:ask-user-question`、`npm run test:plugins`、`npm run test:subagents` |
| 常规完整检查 | `npm run verify` |
| 实际终端交互 | `npm run test:pty:strict`；开发中可用 `npm run test:pty -- --journey=E3` 跑单个场景。 |
| Condense 状态模型 | `npm run test:formal`，需要 Java 与 TLC。见[模型说明](https://github.com/Rycen7822/metis-pi/blob/main/test/formal/README.md)。 |

PTY 检查使用真实 Pi CLI 和 tmux、离线提供商与测试剪贴板。E1 另需 Git。CI 在 Ubuntu 和 Windows 上检查普通构建与测试，在 Linux 上运行严格 PTY 检查。纯文档改动检查事实、链接、示例和包清单即可。

如需查看渲染效果，运行 `npm run preview` 生成 HTML、ANSI 与文本转录。`node scripts/copy-perf.mjs` 测量渲染和提取成本，不测试系统剪贴板。临时探针和日志放在 `.work/`。

## 重建 Pi SDK

补丁源码、上游基线与构建步骤见 [SDK 补丁说明](../sdk-patches/pi-1.5.2/README.md)。

```bash
npm run build:pi-sdk -- "$SDK"
npm run verify:pi-sdk
npm run prepare:pi-sdk
```

`$SDK` 是已按顺序应用补丁的隔离 Pi 源码。构建生成四个 Pi 包和随包归档。用隔离的受管目录验证安装和重启；个人安装不是开发验证的一部分。

## 原生资产与打包

```bash
cargo test --manifest-path native/tools/Cargo.toml --locked --workspace
node native/tools/build-linux-x64.mjs build
node native/tools/build-linux-x64.mjs verify
npm run verify:native-assets
```

Linux 构建需要 Rust musl target、`musl-gcc` 和 `readelf`。Windows 对应的 `native/tools/build-win32-x64.mjs` 需要 MSVC target、VS C++ Build Tools 与 Windows SDK。搜索引擎另见[构建说明](https://github.com/Rycen7822/metis-pi/blob/main/src/neural-search/engine/README.md)。

`prepack` 检查 SDK 和原生资产，构建 Web bundle 并生成子代理工具目录。交付文件变更后，用 `npm pack --dry-run --json --ignore-scripts` 核对包清单；需要验证运行时加载时，实际打包并在隔离 profile 中安装。根 `package.json` 管理入口与随包资源。
