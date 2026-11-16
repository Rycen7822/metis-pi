# 开发与验证

## 环境与常用命令

根依赖与 lock 固定 Pi 1.5.2，平台要求见[兼容性](compatibility.md)。使用完整的 checkout 和根目录的工具链，依赖安装在根目录。禁用 bin links。检查入口调用 TypeScript 源文件，PTY 测试使用同版本 SDK 的真实 CLI。

\`\`\`bash
npm ci --ignore-scripts --bin-links=false --no-audit --no-fund
npm run prepare:subagents
\`\`\`

子代理运行核心只使用 Python 标准库。测试另需 [requirements.txt](https://github.com/Rycen7822/metis-pi/blob/main/test/subagents/requirements.txt) 中的 pytest 9、xdist 与 schema 依赖。

| 命令 | 范围 |
| --- | --- |
| \`npm run check\`、\`check:test\` | 项目与测试的 TypeScript 类型检查。增量缓存位于 \`.work/tsc/\`。 |
| \`npm test\`、\`test:fast\` | Node 测试与 Ask Vitest；core 规则与渲染。 |
| \`npm run test:host\`、\`test:protocol\` | 宿主与包内容；请求、回放、压缩与历史编辑。 |
| \`npm run test:formal\` | [Condense TLA+ 核心模型](../test/formal/README.md)。独立命令，需要 Java 与 TLC。 |
| \`npm run test:io\`、\`test:resource\` | 文件、Git 与归档；进程、锁、timer、缓存与传输。 |
| \`npm run test:lsp\`、\`test:ask-user-question\`、\`test:chrome\` | LSP；问卷；界面、布局与复制。 |
| \`npm run build:plugins\`、\`test:plugins\` | Web bundle 与 MCP CLI；Web 共置测试。 |
| \`npm run test:subagents\` | Python 运行时、IPC、账本与继承。4 个 worker 按文件分配。 |
| \`npm run verify\` | 类型、全部测试，以及实际打包的清单。 |
| \`npm run test:pty:strict\`、\`test:pty\` | 真实 Pi 与 tmux 下的 E1–E4、E6。两者都必须完整执行。 |
| \`npm run preview\` | 用生产渲染器生成未跟踪的 \`docs/preview.html\`、\`transcript.ansi\` 与 \`transcript.txt\`。 |
| \`node scripts/copy-perf.mjs\` | 渲染与提取的成本。剪贴板行为另用 PTY 验收。 |

先运行与改动最接近的已有检查。跨模块改动运行 \`verify\`，终端相关改动再加上 PTY。纯文档改动只需核对事实、链接和交付清单。TLA+ 模型不能替代实现测试，也不向默认验证或插件安装引入 Java 依赖。

## 检查与 CI

- core 测试规则与渲染；contract 测试接入真实 Pi API；protocol 测试最终请求与历史；IO 与 resource 测试持久化、损坏恢复与资源释放。
- 预期值来自独立的合同。每个测试都要清理夹具目录、进程、timer、网络钩子和包装。一次性诊断放进 `.work/`。
- pytest 支持 \`unittest.subTest\`。\`npm run test:subagents -- -n 0\` 可用于检查顺序依赖。
- PTY 测试需要 Pi 与 tmux；E1 还需要 Git。测试在隔离目录中运行，使用离线 provider 与剪贴板 sink。可用 \`-- --journey=E3\` 单独运行某一条。缺少依赖或未执行完成都算失败。

| Journey | 验证内容 |
| --- | --- |
| E1、E2 | Git footer；bash 及后续请求。 |
| E3、E4 | 思考手势；复制、草稿与实际提交。 |
| E6 | 多 skill 补全、payload 与折叠。 |

CI 在 Ubuntu 和 Windows 的 Pi 1.5.2 上运行 \`verify\`。Linux 额外运行严格的 tmux/PTY。独立 job 重建搜索引擎，并核对二进制与单元检查。同一 SHA 已有开放且可合并的 PR 时，功能分支跳过重复的 push 全测；状态未知时仍然运行。同一 PR 的新提交会取消旧运行。main、tag 与手动触发各自分组。Node 的 compile cache 在进程和配置之间隔离。包检查实际运行 \`npm pack --dry-run --json --ignore-scripts\`，安装验收另行进行。

## Pi SDK 源码补丁

[\`sdk-patches/pi-1.5.2/\`](../sdk-patches/pi-1.5.2/README.md) 保存补丁源码与重建方法。\`npm run build:pi-sdk -- "$SDK"\` 从已应用补丁的隔离源码正式构建 ai、tui、codemode 与 coding-agent，同步 codemode 文档，并生成随包归档。\`npm run verify:pi-sdk\` 校验补丁身份与产物。prepack 同样执行检查。

普通的 Git 或 npm 安装与更新，通过 postinstall 自动交付到 managed Pi 1.5.2。启动入口为脚本被禁用、本地包与宿主重装提供兜底。安装沿用 Pi 的 update 锁，在独立的实体目录中准备并验证，然后原子切换启动指针。旧的发行目录与个人数据保留。已在运行的进程仍使用旧 SDK，需要重启。版本或布局不匹配时会明确提示。开发测试应使用隔离的 managedRoot。

## 源码与交付

[架构](architecture.md)列出了各模块的 owner。运行与测试共用 TypeScript 源码，导入显式写 \`.ts\`。类型配置位于 \`config/typescript/\`，Ask 的 Vitest 配置位于 \`config/vitest/\`。Web 与 Recall 保留入口，并继承共享规则。

根 manifest 管理构建依赖。\`scripts/build-web-access.mjs\` 构建两个 Web bundle。子代理的 prepack 会从 Python schema 生成工具目录。

安装包含运行时 TS、Web bundle、Python 与 JS 核心、shell WASM、两个平台的 x64 PTY 与搜索资产、主题、skills、许可，以及 SDK 补丁源码和预编译归档。测试、构建工具与 Rust 源码只保留在 Git 中。

发布范围变化后，要实际打包并解包检查入口、动态资源、二进制和执行权限。用户安装使用随包资产。构建只在开发机上进行。

\`\`\`bash
cargo test --manifest-path native/tools/Cargo.toml --locked --workspace
node native/tools/build-linux-x64.mjs build
node native/tools/build-linux-x64.mjs verify
\`\`\`

Linux helper 需要 Rust musl target、\`musl-gcc\`、\`readelf\`，以及缓存的锁定依赖。Windows 使用 \`node native/tools/build-win32-x64.mjs build\`，需要 MSVC target、VS C++ Build Tools 与 Windows SDK。交叉构建变量见脚本。verify 使用内置的 PE 读取器。\`npm run verify:native-assets\` 核对两个平台的源码、资产、许可字节与当前 ABI，编译需另行执行。manifest 只是清单，是否匹配以核对结果为准。来源见[执行模块来源](provenance/execution/README.md)、[condense 许可](provenance/condense/LICENSE)与 [NOTICE](../NOTICE)。

本地安装用 \`pi install .\`，更新用 \`pi update --extensions\`。用隔离的 profile 验证实际的发现和执行。直接导入只能算冒烟测试。push、发布和个人安装每次都需要当场获得授权。
