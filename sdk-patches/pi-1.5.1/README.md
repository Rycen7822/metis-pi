# Pi 1.5.1 SDK 补丁

唯一基线：[Pi v1.5.1](https://github.com/earendil-works/pi/tree/v1.5.1)，提交
`dd30101cfc5b0609411dd80b6f93adbc14db14cf`。不支持旧版、预发布版或未来版本。
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

按编号顺序应用；`0002` 已由上游覆盖，编号留空。
保留 1.5.1 的 model/thinking 分离记录、树切换后的 thinking 恢复及 clamp 判断；
warming 继续委托 pi-ai 的决策与请求选项，保留 idle/streaming/off 设置、费用格式和连续预热合并展示；
树选择器保留 SearchLine、IME 光标与 label 输入焦点传播，不恢复旧算法来迁就补丁。

- 正文 LRU 按序列化 UTF-8 字节计 16 MiB；普通读取复用至多 1 MiB Buffer。
  超预算单条完整读取但不缓存；树消息预览至多 200 个 UTF-16 单元，与原生搜索前缀一致。
  这是缓存预算，不是进程总内存限制；调用方持有的完整正文仍占内存。
- 历史格式、迁移、context edit、图片、持久化失败回滚和原生取消合同不变。
- OAuth 登录标识仅表达本机凭据存储中的 provider 级连续性。
  账户、路由、headers 与持久检查点范围仍由调用方验证；普通 API key 不获得 OAuth 豁免。
- ai/tui/coding-agent 的完整 dist、CLI bundle、资源必须作为一组交付；不局部替换已安装包。
  构建和测试工作区使用实体副本，不用软链接或硬链接拼装。

## 隔离重建

Linux/WSL、Node ≥22.19；Metis 依赖须为精确 1.5.1 且已使用
`--ignore-scripts --bin-links=false` 准备。`SDK` 必须是新的私有目录。

```bash
set -eu
METIS=/absolute/path/to/metis-pi
SDK=/absolute/path/to/isolated-pi-1.5.1
PATCHES="$METIS/sdk-patches/pi-1.5.1"
git clone --no-hardlinks --branch v1.5.1 https://github.com/earendil-works/pi.git "$SDK"
cd "$SDK"
test "$(git rev-parse HEAD)" = dd30101cfc5b0609411dd80b6f93adbc14db14cf
npm ci --ignore-scripts --workspaces=false --bin-links=false --no-audit --no-fund
npm install --no-save --package-lock=false --ignore-scripts --workspaces=false --bin-links=false \
  --no-audit --no-fund vitest@4.1.12 @xterm/headless@5.5.0 chalk@6.0.0 \
  @types/cross-spawn@6.0.6 @types/hosted-git-info@3.0.5 @types/semver@7.7.1 \
  @types/proper-lockfile@4.1.4 @types/ws@8.18.2 @types/ms@2.1.0
node "$PATCHES/prepare-build.mjs" "$SDK" "$METIS/node_modules"
for patch in "$PATCHES"/000*.patch; do
  git apply --check "$patch"
  git apply "$patch"
done
# 完整 check 还需下述 monorepo 测试依赖和实体 workspace。
npm --prefix "$SDK" run check
npm --prefix "$METIS" run build:pi-sdk -- "$SDK"
npm --prefix "$METIS" run verify:pi-sdk
```

准备脚本校验同版 SDK 与源码声明的工具链（TypeScript 7.0.2、Biome、Vitest），
复制真实发布依赖/模型数据，并生成普通文件形式的工具入口；自有源码的 dist 由正式构建覆盖。
完整 monorepo check 还需要各 workspace 的测试开发依赖（包括 React types、Miniflare、Cloudflare、
evals、schema validator 和浏览器图片包）及 tutorial 的实体 `@todo/app` exports。
依赖或夹具缺失必须单列为阻塞，不添加假声明、不删测试、不放宽 entry-graph 预算或类型/格式检查。

发布前运行受影响的历史、warming、树/IME、OAuth 与 TUI 原生回归。
`build:pi-sdk` 核对官方 SHA，干净重放七补丁并逐路径比对源码，再构建三个 SDK 包；
输出 `assets/pi-sdk/pi-1.5.1.tgz` 与 `src/pi-sdk/distribution.json`，prepack 校验两者和补丁身份。
若 check 格式化改写源码，先同步补丁，再重新构建；不能沿用旧归档改名充当新版本。

## 生效与撤回

安装只切换完整发行目录；已运行的进程需重启 Pi，`/reload` 不替换进程内 SDK。
补丁身份以当前发行目录的 `metis-sdk.json` 为准，`pi --version` 仍为 `1.5.1`。
原版 1.5.1 缺少展示接口时保持原生标题，不通过正文改写模拟补丁能力。
npm 脚本策略拦住 `postinstall` 时，会话入口仍会补装并提示重启；不自动修改 `allowScripts` 授权。

撤回前暂停 Metis 安装/更新并禁用其 SDK 安装入口，避免自动重装；
将安装根目录的 `current-version` 恢复为当前 `metis-sdk.json` 的 `previousRelease`，再重启。
恢复原版时选择保留的官方完整发行目录，不拼接旧新依赖。通常根目录为 `~/.pi/agent/install`，以 launcher 为准。
个人认证、设置、会话和 blobs 保持原处；清理备份或暂存目录前确认相关进程已退出。
