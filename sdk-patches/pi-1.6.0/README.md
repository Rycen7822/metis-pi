# Pi 1.6.0 SDK 补丁

唯一基线：[Pi v1.6.0](https://github.com/earendil-works/pi/tree/v1.6.0)，提交
`faac585884ae2c013a6b1400f3e9e77f10b34bac`。不支持旧版、预发布版或未来版本。
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
| `0009` | 公开聊天及离屏渲染接口；允许视口依赖组件在仅滚动或选区变化时重新求值，其他组件仍复用原生缓存。 |
| `0010` | 投影/分支按有界热正文窗口读取；原生压缩按有效投影准备，完整事件分支首次访问才加载。协作读取支持取消，预览拒绝混读改写后的来源。 |
| `0011` | CLI codemode分离在途准入、FIFO执行与结果消费背压；有界预览保留总数/失败/未结算状态，终态不再更新，迟到结果不序列化。 |
| `0012` | Read显式`format: page`返回原文与行游标/完整性状态；沿用流式读取和原预算，默认string/image与模型正文不变。 |
| `0013` | `pi update --models` 按包过滤和项目授权加载 Metis 模型目录入口；注册不触发后台恢复，由 CLI 等待一次强制同步。 |
| `0014` | 允许扩展为当前会话的自动压缩线设置上限；Pi 和 Condense 读取同一有效预留量。 |
| `0015` | 存在其它聊天内容分隔时，重绘保留各条状态通知的原文；仍合并相邻状态通知。 |
| `0016` | Codemode 按分支元数据定位持久状态，只读取 `codemode-store` 正文；冷读不写入正文缓存。 |
| `0017` | 目录元数据包含输出 schema；可调用网关提供签名与命名空间查询时，统一发现提示并收起重复查询助手。 |
| `0018` | 向显式订阅的扩展发布前台请求的最终载荷，在所有扩展变换之后、协议特定传输处理之前。后台预热和维护请求不发布。 |
| `0019` | 从分支元数据和必要正文构造消息视图；用量在最近有效回执可判定时仅估算尾部。完整投影与路由所需来源记录保留。 |
| `0020` | Codemode 顶层工具说明不嵌安装路径；单次工具差异比较复用 JSON 规范化，不跨请求缓存。 |
| `0021` | Models.complete* 只保留终态，继续转发观察事件；公开流仍可在 result() 后按序消费。 |
| `0022` | 让现有 Read 分页回归通过 SDK 工具适配器和类型检查；不改运行时分页。 |
| `0023` | 恢复时一次读取；首屏复用原始未编辑消息。成功保存压缩后回收旧解码缓存，阻止旧读任务再次准入。 |
| `0024` | 缺失工具定义时为折叠行生成有界文本预览；展开仍显示完整参数和结果。 |
| `0025` | 投影支持按需只读取消息来源和编辑；公开完整视图与扩展事务不变。 |
| `0026` | HTML 导出最后插入会话载荷，避免模板替换扫描已编码的大正文；格式不变。 |
| `0027` | `/resume` 和 `--resume` 列表只保留预览；按查询逐个读取会话，允许取消，保留全文匹配和排序。 |
| `0028` | 连续流式更新中，仅当 assistant 正文和内置 Mermaid 转换状态都未变时复用行缓存；不改变第三方转换器。 |

按编号顺序应用；`0002` 已由上游覆盖，编号留空。
保留上游的 model/thinking 分离记录、树切换后的 thinking 恢复及 clamp 判断；
warming 继续委托 pi-ai 的决策与请求选项，保留 idle/streaming/off 设置、费用格式和连续预热合并展示；
树选择器保留 SearchLine、IME 光标与 label 输入焦点传播，不恢复旧算法来迁就补丁。

- 正文 LRU 按序列化 UTF-8 字节计 16 MiB；普通读取复用至多 1 MiB Buffer。
  超预算单条完整读取但不缓存；树消息预览至多 200 个 UTF-16 单元，与原生搜索前缀一致。
  这是缓存预算，不是进程总内存限制；调用方持有的完整正文仍占内存。
  投影窗口按有效条目的分支顺序选择；默认保留所有条目，可显式请求消息来源和编辑而不读取普通状态正文。
  异步读取独占 fd/Buffer，重写或切分支时按原选区读取当前投影。
  单条解码仍不可中断；调用方跨 await 发布前仍须校验正文，不能用 leaf ID 代替。
  手动/自动压缩共用有效投影准备，旧 `branchEntries` 首次读取仍返回同轮完整数组，不是近期窗口或元数据。
  全量恢复可用 `getBranchAsync` 协作读取，连续记录复用同轮1MiB字节预读，不扩大正文LRU。
  来源失效或完整事件读取失败不得静默继续摘要。预览的冷正文仍依赖原文件，已捕获缓存保持旧值，不是长期脱离来源的完整副本。
- 历史格式、迁移、context edit、默认图片和持久化失败回滚合同不变。
- CLI codemode每次最多128在途、8执行；输入8 Mi/单结果16 Mi/未确认传输32 Mi，单位为JSON字符，不是进程堆上限。
  执行slot保持到guest消费；ready队列不超过执行并发。累计调用不设128/256上限，独立库未配置execute和deterministic start不启用预算。
  原生与Metis预览有界；unfinished表示外部结果未知，取消不回滚，不自动重做。忽略abort的宿主工具可跨脚本存活，本限制不是全局工具配额。
  prelude变化会改变durable指纹，旧检查点不匹配应拒绝恢复。Read page需正整数limit，offset默认1；不提供跨页文件快照，图片和单行超预算明确拒绝。
- 消息视图不为模型加载普通 `custom` 状态正文；编辑、压缩检查点、模型与思考设置仍由同一分支选择规则决定。
  完整投影、虚拟路由需要的原始投影与持久格式不变。用量在未找到可用回执或遇到编辑、压缩等边界时仍走完整估算。
- 恢复选择器不保留所有会话的全文；输入查询后完整读取、匹配单个会话，再处理其余会话。
  查询会重读文件；取消作用于读取和会话之间，单次字符串匹配本身不可中断。公开列表默认仍返回全文。
  CLI 恢复只在分支不变时共享未编辑正文；持久写入、切换会话或首屏消费后不再保留准备数据。压缩回收只影响已解码磁盘缓存，旧记录仍可读取。
- OAuth 登录标识仅表达本机凭据存储中的 provider 级连续性。
  账户、路由、headers 与持久检查点范围仍由调用方验证；普通 API key 不获得 OAuth 豁免。
- ai/tui/codemode/coding-agent 的完整 dist、CLI bundle 和 codemode 文档必须作为一组交付；不局部替换已安装包。
  构建和测试工作区使用实体副本，不用软链接或硬链接拼装。

## 开发与CI依赖

`npm ci --ignore-scripts --bin-links=false` 只安装NPM原版SDK。运行依赖补丁接口的测试前，执行 `npm run prepare:pi-sdk`：
它先核对patch/归档身份及四包版本，再用随包预编译产物替换本项目node_modules中的四包dist和配套文档。
仅供开发/CI，不构建SDK、不访问网络、不触碰managed安装或个人配置。要恢复原版依赖，重新运行npm ci。

## 隔离重建

Linux/WSL、Node ≥22.19；Metis 依赖须为精确 1.6.0 且已使用
`--ignore-scripts --bin-links=false` 准备。`SDK` 必须是新的私有目录。

```bash
set -eu
METIS=/absolute/path/to/metis-pi
SDK=/absolute/path/to/isolated-pi-1.6.0
PATCHES="$METIS/sdk-patches/pi-1.6.0"
git clone --no-hardlinks --branch v1.6.0 https://github.com/earendil-works/pi.git "$SDK"
cd "$SDK"
test "$(git rev-parse HEAD)" = faac585884ae2c013a6b1400f3e9e77f10b34bac
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
`build:pi-sdk` 核对官方 SHA，干净重放全部补丁并逐路径比对源码，再构建四个 SDK 包；
归档包含 `coding-agent/docs/codemode.md`，使运行时指向的文档同步更新；独立沙箱和 bundled worker 均使用补丁后的规则。
输出 `assets/pi-sdk/pi-1.6.0.tgz` 与 `src/pi-sdk/distribution.json`，prepack 校验两者和补丁身份。
若 check 格式化改写源码，先同步补丁，再重新构建；不能沿用旧归档改名充当新版本。

## 生效与撤回

安装只切换完整发行目录；已运行的进程需重启 Pi，`/reload` 不替换进程内 SDK。
补丁身份以当前发行目录的 `metis-sdk.json` 为准，`pi --version` 仍为 `1.6.0`。
原版 1.6.0 首次启动可准备补丁；依赖补丁接口的功能需重启后才注册，不维护第二套运行逻辑。
npm 脚本策略拦住 `postinstall` 时，会话入口仍会补装并提示重启；不自动修改 `allowScripts` 授权。

撤回前暂停 Metis 安装/更新并禁用其 SDK 安装入口，避免自动重装；
将安装根目录的 `current-version` 恢复为当前 `metis-sdk.json` 的 `previousRelease`，再重启。
恢复原版时选择保留的官方完整发行目录，不拼接旧新依赖。通常根目录为 `~/.pi/agent/install`，以 launcher 为准。
安装器保留当前发行版和 `previousRelease`，只清理更早且能确认归属的 Metis 副本，不清理官方 Pi。旧副本仍可能在用、进程检查不受支持或删除失败时，暂不清理；后续运行安装器时重试。个人认证、设置、会话和 blobs 不在清理范围内。
