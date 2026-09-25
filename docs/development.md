# 开发与验证

需要 Node.js >=22.19.0；完整开发检查需要 `npm install --ignore-scripts --no-audit --no-fund` 安装 devDependencies。Pi 的生产安装不提供所有测试所需的宿主依赖。

## 检查入口

| 命令 | 范围 |
| --- | --- |
| `npm run verify` | 先重建并核对 vendor 产物，再做源码/测试/vendor 类型检查、全部 Node 测试、vendor 激活、真实 Pi 宿主 smoke 和包内容 dry-run；PTY 单独运行。 |
| `npm run check:core` | `src/` 类型检查。 |
| `npm run check:test` | 全部 `test/**/*.mts` 的 TypeScript 语义检查。 |
| `npm run test:host` | 真实 Pi 组件的工具槽、显示和宿主交互契约。 |
| `npm run test:chrome` | `test/chrome/` 中全部 `.test.mjs` 和 `.test.mts`。 |
| `npm run test:pty` | 隔离 HOME、真实 tmux/Pi、本地离线 provider；检查点击、工具、todo、skill、复制和布局。 |
| `npm run test:pty:strict` | 发布门禁：缺失 Pi/tmux/Git 或跳过滚轮场景时失败。 |
| `npm run preview` | 从生产渲染器生成 `docs/preview.html`、`docs/transcript.ansi`、`docs/transcript.txt`。 |
| `node scripts/copy-perf.mjs` | 三组成对、隔离进程的原生/来源包装帧耗时，以及包装开启时的复制耗时；不含系统剪贴板。 |

先跑改动附近的测试；跨模块改动完成后运行 `verify`。渲染/交互变动还应运行 PTY；普通 `test:pty` 在缺 Pi/tmux 时会 SKIP，退出 0 不代表交互已验证。发布门禁用 `npm run test:pty:strict`，依赖缺失或设置 `PCX_PTY_SKIP_WHEEL=1` 都会失败。PTY 的复制场景会触发真实剪贴板写入，执行前须确认环境适合。真实宿主 smoke 在独立进程强制 truecolor，避免继承的 `NO_COLOR` 弱化颜色断言。

测试按 `test/unit/`、`transcript/`、`chrome/`、`host/`、`skill/`、`todo/` 分组；根目录 `vendor-codex-*.test.mjs` 覆盖真实构建 provider 的请求/回放。测试应核对最终行为或真实宿主形状，避免只证明内部假设。

## vendor 维护

修改 `vendor/pi-codex-conversion/src/`，再运行：

```bash
npm run vendor:build
npm run vendor:patch
npm run verify
```

`dist/` 和 `changelog.js` 随包分发，必须由源码生成。`vendor:patch` 需要 `references/howaboua-pi-stuff/` 的 pristine 基线；只接受 git diff 的正常退出或差异退出码，启动失败、信号、输出超限及其它错误必须失败并保留旧补丁，不能发布截断输出。升级上游及载荷范围只在 [UPSTREAM.md](../vendor/pi-codex-conversion/UPSTREAM.md)维护；本地差异只在 [PATCHES.md](../vendor/pi-codex-conversion/PATCHES.md)维护。

`vendor:fresh` 重建后检查 tracked 改动和新生成的 untracked 文件是否与 Git 基线一致；未提交的合法源码/产物修改也会导致它失败，因此工作区修改期间需比较重复构建结果，并在隔离上游副本验证补丁重放，不能把该退出码直接当作构建漂移。

## 代码与文档约定

- 显示模块不注册工具或改写模型上下文；`src/todo/` 是独立工具子系统，goal 状态核心只做内存计算，宿主副作用留在 `extensions/goal.ts`。范围由 `test/package.test.mjs` 检查。
- chrome 只消费结构类型与注入能力，不直接导入宿主包。未知宿主契约按现有规则退避；恢复原型时不得覆盖后来安装的补丁。
- 保留错误、锁、提交顺序及回放边界。性能结论需要测量，离线替身不等于真实服务端证明。
- 文档按职责修改原页：README 是入口，features 是用法，configuration 是配置契约，architecture 是职责，VALIDATION 是当前证据，CHANGELOG 是版本摘要。不要逐轮追加过程、复制同一契约或新增审查报告。
- 验证失败和未覆盖项必须保留；旧记录由 Git 历史检索，不另建归档副本。引用代码用文件与符号，避免易失效行号。
- 使用 ESM 与显式 `.ts` 路径；自有源码 2 空格，vendored 文件按原风格维护并保留许可归属。

安装到本地 Pi 用 `pi install .`，重启后加载新进程。发布、推送或修改用户的实际安装配置是独立动作，开发测试不自动执行这些操作。
