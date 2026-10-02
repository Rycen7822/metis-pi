# 开发与验证

## 环境与常用命令

Node.js 最低版本见 [兼容性](compatibility.md)；开发类型与锁文件固定 Pi 1.0.0。使用完整 checkout 并保留锁文件和共享依赖布局，避免重复 TUI 实例影响组件身份。

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

| 命令 | 范围 |
| --- | --- |
| `npm run check` | core、execution 与 condense 类型检查，不生成文件。 |
| `npm run check:test` / `npm run check:condense` | 测试 TS / condense 类型。 |
| `npm test` / `npm run test:fast` | 全部 Node 测试 / core 规则与渲染原语。 |
| `npm run test:host` / `test:protocol` | 真实宿主接线及包内容 / 请求、回放、压缩和历史编辑。 |
| `npm run test:io` / `test:resource` | 文件/Git/归档 / 进程、计时器、锁、缓存和传输。 |
| `npm run test:chrome` | 跨层界面、布局和复制测试。 |
| `npm run verify` | 项目与测试类型 + 全部测试 + pack dry-run。 |
| `npm run test:pty:strict` | 真实 Pi/tmux 的 E1–E4、E6；`test:pty` 同样要求完整执行。 |
| `npm run preview` | 生产渲染器生成本地 `docs/preview.html`、`transcript.ansi`、`transcript.txt`，均不进 Git。 |
| `node scripts/copy-perf.mjs` | 测量渲染/提取成本，不测系统剪贴板延迟。 |

先运行改动附近的已有测试；跨模块变更运行 verify，终端显示/交互变更再运行严格 PTY。文档变更核对事实、链接和实际包内容；结果放 [VALIDATION](../VALIDATION.md)。

## 测试边界

core 使用独立预期验证规则；contract 使用真实 Pi 类/API 验证接线与恢复；protocol 核对最终请求和来源；IO 验证持久化与损坏恢复；resource 观察真实回调和释放；PTY 验证可见帧、输入、手势和复制。

复用现有测试，新增断言须对应具体失败。夹具只准备输入，不能复制业务算法或从结果反推 expected。使用者清理 timer、临时目录、进程和原型包装，网络钩子显式恢复。禁止在正式测试中扫描源码证明旧功能删除；一次性清理核查放 `.work/`。

严格 PTY 需要 Pi、tmux，E1 还需 Git；各 journey 使用独立 Pi、目录、tmux socket、离线 provider 和剪贴板 sink。

CI 使用锁文件安装的 Pi 执行严格 PTY。手工运行时可用 `PI_BIN="$PWD/node_modules/.bin/pi"` 显式选择同一宿主。

| Journey | 验证 |
| --- | --- |
| E1 / E2 | Git footer / bash 执行及后续 provider 请求。 |
| E3 / E4 | 思考手势 / 精确复制、草稿和实际提交。 |
| E6 | 多 skill 补全、输入 payload 和折叠。 |

可用 `npm run test:pty:strict -- --journey=E3` 单跑。缺依赖、跳过滚轮、帧超时或意外 provider 请求均失败；不以旧 scrollback 证明当前显示成功。

## 源码与发布

运行和测试消费同一 TS 模块，导入显式写 `.ts`；condense 与执行模块使用可擦除语法。condense 由根项目统一维护与检查；来源归属见 [NOTICE](../NOTICE)，许可见 [condense LICENSE](provenance/condense/LICENSE) 与 [执行来源](provenance/execution/README.md)。

发布包携带 TS、condense 入口、shell WASM、Linux x64 helper、主题与许可/文档；Rust 来源和开发配置留在 Git。安装依赖宿主 TS 加载器，不新增编译或 npm lifecycle。

原生 helper 使用：

```bash
cargo test --manifest-path native/tools/Cargo.toml --locked --workspace
```

`test/package.test.mjs` 核对实际 pack 文件集合。交付范围改变时还要真实打包、解包检查入口、动态资源、二进制字节和执行权限；本地安装、Git 初装/更新分别在隔离 profile 验证，不链接共享 node_modules。

本地安装为 `pi install .`，更新为 `pi update --extensions`。安装验证不能只直接导入源码；开发测试不等同于生产安装证明。

默认值、用法、模块职责和实测记录分别更新配置页、功能页、架构页与 VALIDATION。改写原段落，避免追加重复说明；版本过程留在 Git。推送、发布和修改个人安装需按当次授权执行。
