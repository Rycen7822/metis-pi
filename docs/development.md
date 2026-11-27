# 开发与验证

从仓库根目录运行。版本与平台要求见 [兼容性](compatibility.md)。普通开发直接使用随包的原生资产。

```bash
npm ci --ignore-scripts --bin-links=false --no-audit --no-fund
npm run prepare:pi-sdk
npm run prepare:subagents
```

`prepare:pi-sdk` 将仓库的 SDK 归档装入本项目的依赖，安装范围限于本项目。
运行问卷测试、`npm test` 或 `npm run verify` 需把 Bun 1.4.0 加入 `PATH`；仍使用 Node/npm 安装依赖。Python 测试的依赖见 [requirements.txt](https://github.com/Rycen7822/metis-pi/blob/main/test/subagents/requirements.txt)；子代理运行时只使用标准库。

## 选择检查

| 改动 | 检查 |
| --- | --- |
| TypeScript 源码、测试或类型配置 | 见[类型检查与类型感知 lint](#类型检查与类型感知-lint) |
| 测试同步规则 | `npm run lint:tests` |
| Recall Query 源码注释 | `npm run lint:comments` |
| 规则与渲染 | `npm run test:fast`、`npm run test:chrome` |
| 宿主、包内容与协议 | `npm run test:host`、`npm run test:protocol` |
| 存储与资源释放 | `npm run test:io`、`npm run test:resource` |
| 扩展和子代理 | `npm run test:lsp`、`npm run test:ask-user-question`、`npm run test:web-access`、`npm run test:subagents` |
| 常规完整检查 | `npm run verify` |
| 实际终端交互 | `npm run test:pty:strict`；开发中可用 `npm run test:pty -- --journey=E3` 跑单个场景。 |
| Condense 状态模型 | `npm run test:formal`，需要 Java 与 TLC。见[模型说明](https://github.com/Rycen7822/metis-pi/blob/main/test/formal/README.md)。 |

`test/core/` 放纯逻辑与渲染规则，`test/contract/` 放真实宿主和扩展入口契约；存储、协议与资源生命周期分在 `test/io/`、`test/protocol/` 和 `test/resource/`。LSP、子代理及形式化验证有专门目录。共享夹具放 `test/helpers/`，专用替身就近放在套件内。问卷测试与私有夹具放 `test/ask-user-question/`；真实 Pi 问卷契约仍放 `test/contract/`。

Web Access 的测试留在 `src/pi-web-access/test/`，由独立命令运行，以保留 Web 工作目录和隔离预加载。修改 Web 源码后先运行 `npm run build:web-access`，再运行 `npm run test:web-access`；测试直接消费两份现有 bundle，Linux CI 核对重建产物与提交一致。

`npm test` 运行根 Node 测试及问卷套件；`npm run verify` 额外运行 Web 与 pytest。Cargo、TLC 和 PTY 使用各自的专用命令。
问卷中经验证可由 Bun 运行的文件列在 [Bun 清单](../config/bun/ask-files.json)，其余和新增文件默认由 Vitest 运行。
两边复用原有测试和隔离 setup；依赖 Vitest 模块 mock、异步假时钟，或遇到 Bun Unicode 行为差异的用例保留在 Vitest。
CI 的 Ubuntu、Windows 矩阵并行运行类型检查、lint、根测试、Web Access 和 pytest；两项平台检查要求整个矩阵通过。
CI 还运行 Linux 严格 PTY 和 Neural Search engine 的 Rust 库测试。原生工具、语义 CLI 和形式化验证各有独立入口；
[语义搜索基准](../benchmarks/semantic/README.md)独立于产品套件。

CI 用 Node 原生分片分别跑根测试和 Web Access；问卷套件只在根测试的第一片执行，CI 也只在该分片安装 Bun。
本地可用 `npm test -- --test-shard=1/2` 或 `npm run test:web-access -- --test-shard=2/2` 复跑。
子代理的 pytest 用 xdist 的四个 worker 和 `worksteal`，缓存在 `.work/test-cache/subagents/`。
一次性测试和结果放 `.work/`，与正式套件分开。

PTY 检查使用真实 Pi CLI、tmux、离线提供商和测试剪贴板，E1 另需 Git。纯文档改动只需检查事实、链接和示例。

如需查看渲染效果，运行 `npm run preview` 生成 HTML、ANSI 与文本转录。`node scripts/copy-perf.mjs` 仅测量渲染和提取成本。临时探针和日志放在 `.work/`。

### 类型检查与类型感知 lint

按页首步骤安装依赖并运行 `npm run prepare:pi-sdk`。命令行检查使用锁定的 TypeScript 7 原生 `tsc`（`tsc-native`）；
`typescript` 包供需要 JavaScript API 的工具使用。CI 的原生编译缓存与旧版分开。

| 什么时候跑 | 命令 | 检查什么 |
| --- | --- | --- |
| 修改 TypeScript 源码、公开类型、依赖声明或 `tsconfig` | `npm run check` | 用 `tsc` 检查核心、执行模块、Condense、插件和扩展入口的类型契约。只改 Condense 等单一模块时，可先用 `npm run check:condense` 快速反馈。 |
| 修改 TypeScript 测试、测试夹具，或改变测试依赖的接口 | `npm run check:test` | 用 `tsc` 检查 `test/**/*.mts`、问卷测试及其夹具，仅执行类型检查。 |
| 修改源码或问卷用例中的 TypeScript，尤其是 Promise、事件回调或后台任务 | `npm run lint:types` | 用 Oxlint `--type-aware` 和 `tsrs` 检查类型正确但用法容易出错的代码。默认扫描 `src/`、`extensions/` 和 `test/ask-user-question/`；JavaScript 由其他 lint 规则处理。 |

开发中可以先定向检查改过的文件，例如 `npm run lint:types -- extensions/mcp.ts`。CI 会运行全范围 lint；跨模块接口改动需运行 `npm run check`。

[类型感知规则配置](../.oxlintrc.types.jsonc) 将以下三条规则设为错误：

| 规则 | 拦截什么 | 怎么处理 |
| --- | --- | --- |
| `no-floating-promises` | 检查 Promise 的等待、返回与拒绝处理 | 使用 `await` 或 `return`，由调用方处理完成与失败；后台任务需提供实际的拒绝处理路径。 |
| `no-misused-promises` | 把 Promise 当作布尔条件，或把异步函数传入同步回调接口 | 先等待再判断；对事件监听器等同步接口，用同步回调启动任务，并显式处理拒绝。 |
| `await-thenable` | 对同步返回值等非 thenable 值使用 `await` | 同步操作直接调用；如果本应等待异步工作，检查是否拿错了值或调用了错误的 API。 |

`lint:types` 负责类型感知规则，`tsc` 负责类型检查。本地的 `npm run verify` 包含两项 `tsc` 检查；CI 另跑 `lint:types` 和 `lint:tests`。

### 测试同步规则

修改测试的等待、轮询或定时逻辑时，运行 `npm run lint:tests`。该检查独立于类型信息。CI 用 [Landmines](https://github.com/interfere-inc/landmines) 拦截对 spy 或请求记录的无信号轮询，问卷测试另禁止固定休眠。优先等待操作、回调信号或假时钟。外部进程可就绪条件进行有界检查；真实计时测试可等待时间经过。保留故障超时和协议边界的离线替身。规则范围限于此处列出的项目约定。

### 源码注释基线

`lint:comments` 只检查 Recall Query 的 `context.ts`、`input-budget.ts`、`session-recall.ts` 和 `window.ts`。新增或改写的注释限于许可、必要的工具指令、对外契约和可核实的外部约束，并按 lint 提示更新 [保留清单](../config/lint/recall-comments.json)。删除注释时同时删除对应条目；每个条目只允许在该文件中出现一处。实现取舍见 [架构决策](decisions.md)。

## 重建 Pi SDK

补丁源码、上游基线与构建步骤见 [SDK 补丁说明](../sdk-patches/pi-1.6.1/README.md)。

```bash
npm run build:pi-sdk -- "$SDK"
npm run verify:pi-sdk
npm run prepare:pi-sdk
```

`$SDK` 是已按顺序应用补丁的隔离 Pi 源码。构建生成四个 Pi 包和随包归档。在隔离的受管目录中验证安装和重启，该流程与个人 Pi 安装隔离。

## 原生资产与打包

```bash
cargo test --manifest-path native/tools/Cargo.toml --locked --workspace
node native/tools/build-linux-x64.mjs build
node native/tools/build-linux-x64.mjs verify
npm run verify:native-assets
```

Linux 构建需要 Rust musl target、`musl-gcc` 和 `readelf`。Windows 对应的 `native/tools/build-win32-x64.mjs` 需要 MSVC target、VS C++ Build Tools 与 Windows SDK。搜索引擎另见[构建说明](https://github.com/Rycen7822/metis-pi/blob/main/src/neural-search/engine/README.md)。

Recall 的 Linux x64 worker 和其他原生组件一样随 Git 检出及 npm 包分发。修改 Rust worker 或其本地编码器依赖后，在 Linux x64 / glibc 2.39 上用 Rust 1.94.0 执行 `npm run build:recall`，一并更新 worker、完整性清单和依赖许可。CI 和 `prepack` 会核对源码与产物；安装使用预编译 worker。Bekko128 由 Semantic Search 的安装流程准备，与 worker 分开发布。

`prepack` 检查 SDK 和原生资产，构建 Web bundle 并生成子代理工具目录。交付文件变更后，用 `npm pack --dry-run --json --ignore-scripts` 核对包清单；需要验证运行时加载时，实际打包并在隔离 profile 中安装。根 `package.json` 管理入口与随包资源。
