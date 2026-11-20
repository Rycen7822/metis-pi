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
| TypeScript 源码、测试或类型配置 | 见[类型检查与类型感知 lint](#类型检查与类型感知-lint) |
| 测试同步规则 | `npm run lint:tests` |
| 规则与渲染 | `npm run test:fast`、`npm run test:chrome` |
| 宿主、包内容与协议 | `npm run test:host`、`npm run test:protocol` |
| 存储与资源释放 | `npm run test:io`、`npm run test:resource` |
| 扩展和子代理 | `npm run test:lsp`、`npm run test:ask-user-question`、`npm run test:web-access`、`npm run test:subagents` |
| 常规完整检查 | `npm run verify` |
| 实际终端交互 | `npm run test:pty:strict`；开发中可用 `npm run test:pty -- --journey=E3` 跑单个场景。 |
| Condense 状态模型 | `npm run test:formal`，需要 Java 与 TLC。见[模型说明](https://github.com/Rycen7822/metis-pi/blob/main/test/formal/README.md)。 |

`test/core/` 放纯逻辑与渲染规则，`test/contract/` 放真实宿主和扩展入口契约；存储、协议与资源生命周期分在 `test/io/`、`test/protocol/` 和 `test/resource/`。LSP、子代理及形式化验证有专门目录。共享夹具放 `test/helpers/`，专用替身就近放在套件内。问卷 Vitest 与私有夹具放 `test/ask-user-question/`；真实 Pi 问卷契约仍放 `test/contract/`。

Web Access 的测试留在 `src/pi-web-access/test/`，由独立命令运行，以保留 Web 工作目录和隔离预加载。修改 Web 源码后先运行 `npm run build:web-access`，再运行 `npm run test:web-access`；测试直接消费两份现有 bundle，Linux CI 核对重建产物与提交一致。

`npm test` 运行根 Node 测试和问卷 Vitest，不运行 Web、pytest、Cargo、TLC 或 PTY。`npm run verify` 加入 Web 与 pytest；CI 另外运行严格 PTY 和 Neural Search engine 的 Rust 库测试。原生工具测试、语义 CLI 测试和形式化验证各有独立入口；基准自检见 [语义搜索基准](../benchmarks/semantic/README.md)，不属于产品套件。

一次性测试、临时复现脚本及结果放 `.work/`，不加入正式套件发现。子代理的 pytest 缓存在 `.work/test-cache/subagents/`。

PTY 检查使用真实 Pi CLI 和 tmux、离线提供商与测试剪贴板。E1 另需 Git。CI 在 Ubuntu 和 Windows 上检查普通构建与测试，在 Linux 上运行严格 PTY 检查。纯文档改动检查事实、链接、示例和包清单即可。

如需查看渲染效果，运行 `npm run preview` 生成 HTML、ANSI 与文本转录。`node scripts/copy-perf.mjs` 测量渲染和提取成本，不测试系统剪贴板。临时探针和日志放在 `.work/`。

### 类型检查与类型感知 lint

按页首步骤安装依赖、运行 `npm run prepare:pi-sdk`，再从仓库根目录运行下列命令。

| 什么时候跑 | 命令 | 检查什么 |
| --- | --- | --- |
| 修改 TypeScript 源码、公开类型、依赖声明或 `tsconfig` | `npm run check` | 用 `tsc` 检查核心、执行模块、Condense、插件和扩展入口的类型契约。只改 Condense 等单一模块时，可先用 `npm run check:condense` 快速反馈。 |
| 修改 TypeScript 测试、测试夹具，或改变测试依赖的接口 | `npm run check:test` | 用 `tsc` 检查 `test/**/*.mts`、问卷 Vitest 测试及其夹具；不执行测试。 |
| 修改源码或问卷用例中的 TypeScript，尤其是 Promise、事件回调或后台任务 | `npm run lint:types` | 用 Oxlint `--type-aware` 和 `tsrs` 检查类型正确但用法容易出错的代码。默认扫描 `src/`、`extensions/` 和 `test/ask-user-question/`，不检查 JavaScript。 |

开发中可以先定向检查改过的文件，例如 `npm run lint:types -- extensions/mcp.ts`。CI 会运行全范围 lint；改动跨模块接口时，不要用定向 lint 代替 `npm run check`。

[类型感知规则配置](../.oxlintrc.types.jsonc) 将以下三条规则设为错误：

| 规则 | 拦截什么 | 怎么处理 |
| --- | --- | --- |
| `no-floating-promises` | 调用返回 `Promise`，却没有等待、返回或处理拒绝 | `await` 或 `return`，让调用方负责完成与失败；确实要在后台运行时，显式处理拒绝，不要只加 `void` 消警。 |
| `no-misused-promises` | 把 Promise 当作布尔条件，或把异步函数传给不会等待返回值的回调接口 | 先等待再判断；对事件监听器等同步接口，用同步回调启动任务，并显式处理拒绝。 |
| `await-thenable` | 对同步返回值等非 thenable 值使用 `await` | 同步操作直接调用；如果本应等待异步工作，检查是否拿错了值或调用了错误的 API。 |

`lint:types` 不启用 `--type-check`，不能代替 `tsc`。本地的 `npm run verify` 包含两项 `tsc` 检查，但不运行 lint；CI 另跑 `lint:types` 和 `lint:tests`。

### 测试同步规则

修改测试的等待、轮询或定时逻辑时，运行 `npm run lint:tests`。它不需要类型信息。CI 用 [Landmines](https://github.com/interfere-inc/landmines) 拦截对 spy 或请求记录的无信号轮询，问卷 Vitest 测试另禁止固定休眠。优先等待操作、回调信号或假时钟。外部进程没有事件时可有界检查就绪条件；真实计时测试可等待时间经过。保留故障超时和协议边界的离线替身。不启用其他上游规则。

## 重建 Pi SDK

补丁源码、上游基线与构建步骤见 [SDK 补丁说明](../sdk-patches/pi-1.6.0/README.md)。

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

发布带混合会话检索的 Linux x64 包前，在 glibc 2.39 构建环境运行 `npm run build:recall`。它只暂存 Recall worker，不安装 Pi 或下载模型；Bekko128 继续用单独发布的模型资产。没有该 worker 的包仍支持字面会话检索。

`prepack` 检查 SDK 和原生资产，构建 Web bundle 并生成子代理工具目录。交付文件变更后，用 `npm pack --dry-run --json --ignore-scripts` 核对包清单；需要验证运行时加载时，实际打包并在隔离 profile 中安装。根 `package.json` 管理入口与随包资源。
