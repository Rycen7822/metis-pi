# 开发与验证

## 开发环境

运行要求 Node.js >=22.19.0。开发和 CI 使用完整 Git checkout，并按锁文件安装开发依赖：

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

Pi 开发类型依赖固定为 0.99.1；升级时同步更新相关包和锁文件。当前锁文件由 npm 12.0.2 生成，也经过 CI 的 npm 10.9.8 安装验证。使用 npm 12 生成锁文件需要 Node.js >=22.22.2；应保留宿主与扩展共享的依赖布局，避免重新求解上游 shrinkwrap 后出现重复 TUI 实例、破坏组件身份和原型适配。

Pi 的生产安装不会提供全部测试依赖。直接安装并启动插件、在开发环境运行测试、加载真实打包产物是不同的验证范围。

## 常用命令

| 命令 | 范围 |
| --- | --- |
| `npm run check` | 直接检查项目及其导入的 TS 源码，不生成文件。 |
| `npm run check:core` | 直接检查 `src/`。 |
| `npm run check:test` | 直接检查 `test/**/*.mts` 的类型语义。 |
| `npm test` | 所有 `.test.mjs` / `.test.mts`，由 Node 按文件隔离执行。 |
| `npm run test:fast` | `test/core/` 的规则、状态机和渲染原语。 |
| `npm run test:host` | `test/contract/` 的真实宿主接口与扩展接线，加实际包内容检查。 |
| `npm run test:protocol` | 请求准备、转录、compaction/replay 和 context operation 协议。 |
| `npm run test:io` | Git、文件、todo 持久化、写入前后镜像与日志归档。 |
| `npm run test:resource` | 进程、计时器、锁、缓存/heap、剪贴板传输和状态存储。 |
| `npm run test:chrome` | 跨上述层级选取界面、布局、复制与相关资源测试。 |
| `npm run verify` | 项目/测试/vendor 类型、全部 Node 测试及 `npm pack --dry-run`。 |
| `npm run test:pty:strict` | 真实 Pi/tmux 的 E1–E6；`test:pty` 采用相同必执行规则。 |
| `npm run vendor:smoke` | 单独运行真实 Pi 的 vendor 注册契约；已包含在完整测试中。 |
| `npm run preview` | 从生产渲染器生成 `docs/preview.html`、`transcript.ansi`、`transcript.txt`。 |
| `node scripts/copy-perf.mjs` | 成对测量渲染与文本提取成本，不测系统剪贴板写入延迟。 |

先运行改动附近的已有测试；跨模块变更运行 `verify`，终端显示/交互变更再运行严格 PTY。仅修改文档时核对事实、链接和包内容。当前执行结果、环境及未覆盖项记录在 [VALIDATION](../VALIDATION.md)。

## 测试职责与维护规则

完整业务判定表放在最接近规则的一层；跨层测试验证接线和可观察结果。

| 边界 | 主要责任 |
| --- | --- |
| `core/` | 独立输入/预期、状态转换、预算和格式；不为了纯规则启动会话或创建仓库。 |
| `contract/` | 真实 Pi 类/API、工具注册、事件、组件安装与恢复；保留接收者、部分启动失败和第三方接管场景。 |
| `protocol/` | 最终 provider 请求、工具配对、压缩窗口、历史编辑及分页；预期不能由被测 payload 反推。 |
| `io/` | 真实磁盘/Git、持久化、损坏恢复和并发写入；按文件/仓库生命周期组织。 |
| `resource/` | timer、进程、锁、传输、缓存与释放；必须观察真实回调/释放，静默回调不能证明资源已清理。 |
| PTY | 真实输入、手势、当前可见帧、精确复制及离线 provider 请求。 |

几个跨层边界需要特别保持：

- Git 的 parser、受控采样/定时器和真实仓库分别归 core/resource/io；真实运行中 footer 更新归 PTY E1。定时器测试不能主动刷新来制造成功。
- todo 的领域规则、工具映射、磁盘 store 和 UI 会话交接分别验证；重启后的面板可见性归 PTY E5。
- write 的前后镜像与交错写入归 IO，真实工具执行和 patch 快照接线归 host-entry，布局预算归 core renderer。
- provider 的 wire 预期独立于夹具；SessionManager 负责真实分支/entry 语义，完整入口负责注册、生命周期和最终请求。
- 复制测试保留精确空白、原生回退、当前帧身份及 heap/进程释放，PTY E4 核对实际 Ctrl+C 文本与草稿行为。

优先复用现有测试，不以新增数量证明质量。新增断言应对应具体失败；避免内部重建次数、对象身份或动画逐帧值的无契约约束。夹具只准备输入，不另造业务算法或从实际结果生成 expected。禁止网络的用例显式安装并恢复钩子；定时器、临时目录、会话及原型包装由使用者清理。

## 严格终端验证

需要 Pi、tmux，E1 还需要 Git。每条 journey 使用独立 Pi 进程和工作目录，本地 provider 提供离线响应；独立 tmux socket 和剪贴板 sink 避免写入系统剪贴板。

| Journey | 验证内容 |
| --- | --- |
| E1 | 真实 Git 修改到 footer 计数与颜色。 |
| E2 | bash 调用、实际执行结果及 provider 后续请求。 |
| E3 | 思考块单击、滚轮、双击和可见内容。 |
| E4 | 滚动/留白下的精确复制、草稿保留与无选区清空，随后实际提交。 |
| E5 | todo 面板交互、完成后收起及真实重启。 |
| E6 | 多 skill 触发/补全、完整输入 payload 和点击折叠。 |

可用 `npm run test:pty:strict -- --journey=E3` 单跑一段。缺依赖、设置 `PCX_PTY_SKIP_WHEEL=1` 或等待稳定帧超时均失败。驱动清除 `NO_COLOR` 并启用 truecolor；颜色断言不能被环境变量削弱。检查当前可见帧，不能用旧 scrollback 证明显示成功。provider 的意外请求或未消费响应也会失败。

## 执行模块与第三方来源

执行工具在 `src/execution/`，V8 在 `src/code-mode/`，入口为 `extensions/execution.ts`；根扩展、测试与共享状态消费者使用同一 TS 源码路径。pi-condense 保留自己的来源目录和单行入口。不要重新引入编译副本或重复包清单。

- `check` 同时执行 `check:core` 与 `check:execution`；后者覆盖执行模块和 V8，保留严格及可擦除语法检查。`vendor:check` 只检查 pi-condense；`vendor:build` / `vendor:fresh` 是该检查的别名，不生成 JS 或声明。
- 项目与测试检查直接消费源码，不依赖本地残留的 `.d.ts`。condense 与执行模块 使用可擦除 TS 语法，本地模块导入显式写 `.ts`。
- 累计 `local.patch`、`vendor:patch` 和覆盖式 `vendor:sync` 已退休。上游更新在独立分支比较并选择性移植，源码与 Git 历史保存实际分歧。

精确来源、许可、载荷范围与升级步骤见 [conversion UPSTREAM](provenance/codex-conversion/UPSTREAM.md) / [PATCHES](provenance/codex-conversion/PATCHES.md) 和 [condense UPSTREAM](../vendor/pi-condense/UPSTREAM.md) / [PATCHES](../vendor/pi-condense/PATCHES.md)。

## 发布与安装验证

发布包携带运行 TS、condense 入口、shell parser WASM、本地二进制、提示文档、changelog、根 manifest 与许可/来源说明。Rust 来源和开发配置留在 Git。宿主现有 TS 加载器负责运行，本地/Git/npm 安装不增加编译步骤，不依赖开发 TypeScript 或 npm lifecycle。

`native/tools` 和 `native/code-mode-host` 分别维护 Cargo workspace。固定 V8 的 host 发布构建仍使用 `scripts/build-code-mode-host-release.sh`；运行期优先解析 `assets/native-tools/code-mode/<platform>-<arch>`，随后查 `native/code-mode-host/target/release` 和原版本缓存。构建临时文件不进入发布包。

`test/package.test.mjs` 检查实际 `npm pack --dry-run` 文件集合。变更交付范围时还需真实打包、解包并验证入口、动态资源、二进制内容及执行权限；本地路径、Git 初装/更新应分别在隔离 profile 验证。Git 更新会清理 ignored 文件，真实 npm 安装目录不能链接共享 node_modules。

本地安装命令为 `pi install .`；Pi 0.99.1 更新扩展使用 `pi update --extensions`。重新加载后检查实际入口；不以源码直接导入替代安装证明。

## 代码与文档约定

- 显示源码、独立功能入口和 vendor 的职责见 [架构](architecture.md)；保留工具来源守卫、取消/恢复、锁与提交顺序。chrome 通过注入能力访问宿主。
- 使用 ESM 和显式 `.ts` 路径；自有源码采用 2 空格，vendor 保留原风格与许可。
- 默认值、功能用法、模块职责和实测记录分别维护在配置页、功能页、架构页与 VALIDATION；修改原段落，避免追加同义记录或另建历史副本。
- 性能结论注明环境和测量范围；离线 mock 只能证明被观察的本地行为。发布、推送和修改个人安装是独立操作。
