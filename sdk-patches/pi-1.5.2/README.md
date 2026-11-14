# Pi 1.5.2 SDK 补丁

唯一基线：[Pi v1.5.2](https://github.com/earendil-works/pi/tree/v1.5.2)，提交
`b4afdddf44e059c67ccf5097e5317d913521b470`。不支持旧版、预发布版或未来版本。
上游 MIT 许可见 [LICENSE.upstream](LICENSE.upstream)。补丁随 Metis 的完整预编译 SDK 交付。

## 作用与边界

| 编号 | 作用 |
| --- | --- |
| `0000` | 正式 CLI bundler 解析实体 workspace，保留包 exports/subpath 条件，不依赖软链接。 |
| `0001` | 只复用上一帧可见行的合成结果；组件 render、布局、滚动、选区和复制仍由 Pi 执行。 |
| `0003` | 常驻历史元数据，JSONL 正文按需读取；同步迁移统计、恢复、选择、压缩等消费者。 |
| `0004` | 树浏览使用元数据与有界预览；完整复制、分页、异步查询及取消保留原生语义。 |
| `0005` | 一次性扫描复用缓存命中，但不准入冷正文，避免挤出交互热正文。 |
| `0006` | 原生认证层区分登录归属与正常 token 刷新；重新登录、登出及外部凭据替换不继承归属。 |
| `0007` | 摘要通过 `getDisplayHeader(message)` 返回标题/副行，技能通过 `getDisplayName(skillBlock)` 返回显示名；两状态共用原生渲染，正文和 transformer 不受装饰影响。 |
| `0008` | 脚本可调用 `tool_search` 时收起 `searchTools()`；模型说明和错误提示同步，无网关时保留原生发现。 |
| `0009` | 公开主 TUI 的 renderer、编辑器主题、聊天 viewport 及工具 renderer 解析；离屏帧保留光标，BTW 复用完整渲染/滚动/选择链，不接管终端。 |
| `0010` | 投影/分支按有界热正文窗口读取；原生压缩按有效投影准备，完整事件分支首次访问才加载。协作读取支持取消，预览拒绝混读改写后的来源。 |
| `0011` | CLI codemode分离在途准入、FIFO执行与结果消费背压；有界预览保留总数/失败/未结算状态，终态不再更新，迟到结果不序列化。 |
| `0012` | Read显式`format: page`返回原文与行游标/完整性状态；沿用流式读取和原预算，默认string/image与模型正文不变。 |

按编号顺序应用；`0002` 已由上游覆盖，编号留空。
保留 1.5.2 的 model/thinking 分离记录、树切换后的 thinking 恢复及 clamp 判断；
warming 继续委托 pi-ai 的决策与请求选项，保留 idle/streaming/off 设置、费用格式和连续预热合并展示；
树选择器保留 SearchLine、IME 光标与 label 输入焦点传播，不恢复旧算法来迁就补丁。

- 正文 LRU 按序列化 UTF-8 字节计 16 MiB；普通读取复用至多 1 MiB Buffer。
  超预算单条完整读取但不缓存；树消息预览至多 200 个 UTF-16 单元，与原生搜索前缀一致。
  这是缓存预算，不是进程总内存限制；调用方持有的完整正文仍占内存。
  投影窗口按有效条目的分支顺序选择，所有条目仍完整返回；异步读取独占 fd/Buffer，重写或切分支时回到当前完整投影。
  单条解码仍不可中断；调用方跨 await 发布前仍须校验正文，不能用 leaf ID 代替。
  手动/自动压缩共用有效投影准备，旧 `branchEntries` 首次读取仍返回同轮完整数组，不是近期窗口或元数据。
  全量恢复可用 `getBranchAsync` 协作读取，连续记录复用同轮1MiB字节预读，不扩大正文LRU。
  来源失效或完整事件读取失败不得静默继续摘要。预览的冷正文仍依赖原文件，已捕获缓存保持旧值，不是长期脱离来源的完整副本。
- 历史格式、迁移、context edit、默认图片和持久化失败回滚合同不变。
- CLI codemode每次最多128在途、8执行；输入8 Mi/单结果16 Mi/未确认传输32 Mi，单位为JSON字符，不是进程堆上限。
  执行slot保持到guest消费；ready队列不超过执行并发。累计调用不设128/256上限，独立库未配置execute和deterministic start不启用预算。
  原生与Metis预览有界；unfinished表示外部结果未知，取消不回滚，不自动重做。忽略abort的宿主工具可跨脚本存活，本限制不是全局工具配额。
  prelude变化会改变durable指纹，旧检查点不匹配应拒绝恢复。Read page需正整数limit，offset默认1；不提供跨页文件快照，图片和单行超预算明确拒绝。
- OAuth 登录标识仅表达本机凭据存储中的 provider 级连续性。
  账户、路由、headers 与持久检查点范围仍由调用方验证；普通 API key 不获得 OAuth 豁免。
- ai/tui/codemode/coding-agent 的完整 dist、CLI bundle 和 codemode 文档必须作为一组交付；不局部替换已安装包。
  构建和测试工作区使用实体副本，不用软链接或硬链接拼装。

## 开发与CI依赖

`npm ci --ignore-scripts --bin-links=false` 只安装NPM原版SDK。运行依赖补丁接口的测试前，执行 `npm run prepare:pi-sdk`：
它先核对patch/归档身份及四包版本，再用随包预编译产物替换本项目node_modules中的四包dist和配套文档。
仅供开发/CI，不构建SDK、不访问网络、不触碰managed安装或个人配置。要恢复原版依赖，重新运行npm ci。

## 隔离重建

Linux/WSL、Node ≥22.19；Metis 依赖须为精确 1.5.2 且已使用
`--ignore-scripts --bin-links=false` 准备。`SDK` 必须是新的私有目录。

```bash
set -eu
METIS=/absolute/path/to/metis-pi
SDK=/absolute/path/to/isolated-pi-1.5.2
PATCHES="$METIS/sdk-patches/pi-1.5.2"
git clone --no-hardlinks --branch v1.5.2 https://github.com/earendil-works/pi.git "$SDK"
cd "$SDK"
test "$(git rev-parse HEAD)" = b4afdddf44e059c67ccf5097e5317d913521b470
npm ci --ignore-scripts --workspaces=false --bin-links=false --no-audit --no-fund
npm install --no-save --package-lock=false --ignore-scripts --workspaces=false --bin-links=false \
  --no-audit --no-fund vitest@4.1.12 @xterm/headless@5.5.0 chalk@6.0.0 \
  @types/cross-spawn@6.0.6 @types/hosted-git-info@3.0.5 @types/semver@7.7.1 \
  @types/proper-lockfile@4.1.4 @types/ws@8.18.2 @types/ms@2.1.0 \
  @types/react@19.2.14 @types/react-dom@19.2.3 react@19.3.0 react-dom@19.3.0 \
  miniflare@5.20261023.2-beta @cloudflare/vitest-plugin@1.4.10 \
  @silvia-odwyer/photon@0.3.3 fake-indexeddb@6.2.6 \
  @vitest-evals/core@0.15.0 vitest-evals@0.15.0 @cfworker/json-schema@4.1.1 ata-validator@1.61.3
node "$PATCHES/prepare-build.mjs" "$SDK" "$METIS/node_modules"
for patch in "$PATCHES"/*.patch; do
  git apply --check "$patch"
  git apply "$patch"
done
npm --prefix "$SDK" run check
npm --prefix "$METIS" run build:pi-sdk -- "$SDK"
npm --prefix "$METIS" run verify:pi-sdk
```

准备脚本校验同版 SDK 与源码声明的工具链（TypeScript 7.0.2、Biome、Vitest），
复制真实发布依赖/模型数据，并生成普通文件形式的工具入口；自有源码的 dist 由正式构建覆盖。
上述测试依赖版本来自上游 lock，覆盖完整仓库检查。教程 `@todo/app` 使用指回原源码的实体转发入口，
避免副本破坏相对引用或制造第二个模块实例；类型也由同一源码导出，不添加假声明或放宽检查。

发布前运行受影响的历史、warming、树/IME、OAuth 与 TUI 原生回归。
`build:pi-sdk` 核对官方 SHA，干净重放十二补丁并逐路径比对源码，再构建四个 SDK 包；
归档包含 `coding-agent/docs/codemode.md`，使运行时指向的文档同步更新；独立沙箱和 bundled worker 均使用补丁后的规则。
输出 `assets/pi-sdk/pi-1.5.2.tgz` 与 `src/pi-sdk/distribution.json`，prepack 校验两者和补丁身份。
若 check 格式化改写源码，先同步补丁，再重新构建；不能沿用旧归档改名充当新版本。

## 生效与撤回

安装只切换完整发行目录；已运行的进程需重启 Pi，`/reload` 不替换进程内 SDK。
补丁身份以当前发行目录的 `metis-sdk.json` 为准，`pi --version` 仍为 `1.5.2`。
原版 1.5.2 缺少展示接口时保持原生标题，不通过正文改写模拟补丁能力。
npm 脚本策略拦住 `postinstall` 时，会话入口仍会补装并提示重启；不自动修改 `allowScripts` 授权。

撤回前暂停 Metis 安装/更新并禁用其 SDK 安装入口，避免自动重装；
将安装根目录的 `current-version` 恢复为当前 `metis-sdk.json` 的 `previousRelease`，再重启。
恢复原版时选择保留的官方完整发行目录，不拼接旧新依赖。通常根目录为 `~/.pi/agent/install`，以 launcher 为准。
个人认证、设置、会话和 blobs 保持原处；清理备份或暂存目录前确认相关进程已退出。
