# Pi 1.5.0 SDK 补丁

基线为 [Pi v1.5.0](https://github.com/earendil-works/pi/tree/v1.5.0)，提交
`f9a26365568127461c47a07a37dcb42c140a3ac5`。仅支持该版本；上游 MIT 许可见 [LICENSE.upstream](LICENSE.upstream)。
这些是 SDK 源码补丁，随 Metis 交付预编译产物。

## 补丁作用

| 补丁 | 作用 |
| --- | --- |
| `0000-physical-workspace-bundling.patch` | 让正式 CLI 构建解析实体 workspace，保留 exports/subpath 规则，解决无软链接构建时的模块解析。 |
| `0001-reuse-visible-row-composition.patch` | 复用上一帧可见行的合成结果，减少重复拼接；组件 render、布局、选区、复制和滚动仍由 Pi 执行。 |
| `0003-load-session-bodies-on-demand.patch` | 常驻历史元数据，按需读取 JSONL 正文；同步调整启动、统计、恢复和压缩等消费者。 |
| `0004-preview-session-trees-without-history-bodies.patch` | 树浏览使用元数据和有界预览，完整复制、全文查询、分页与取消保留原语义。 |
| `0005-preserve-hot-bodies-during-history-scans.patch` | 扫描命中时复用热正文，未命中内容只供本次读取，避免一次性扫描挤占正文缓存。 |
| `0006-preserve-oauth-login-continuity.patch` | 由原生认证层区分登录归属与 token 刷新，使正常刷新期间的压缩结果仍可采用；新登录和外部凭据替换改变归属。 |

按编号顺序应用。`0002` 对应能力已被上游覆盖，编号留空。

## 安装与生效

- 官方 managed 布局的 Node Pi 1.5.0：普通 Git/npm 安装或 `pi update --extensions` 自动交付全部补丁，用户侧无需编译。
- 安装器与 Pi 自更新共用锁，准备完整新发行目录、验证 CLI 后原子切换启动指针；旧目录、依赖和个人数据保留。
- 已有进程继续使用原 SDK，重启 Pi 后加载新目录；`/reload` 仅重载扩展。启动入口为本地包、禁用安装脚本等情况提供安装兜底，并提示重启。
- managed 宿主版本不符时安装命令报错；非 managed 布局只提示补丁未安装，原宿主保持。
- `pi --version` 仍显示 `1.5.0`。补丁状态以当前发行目录的 `metis-sdk.json` 为准，其中记录源码补丁身份、归档校验值和上一发行目录。

## 隔离重建

使用 Linux/WSL、Node ≥22.19 和完整 Metis checkout。Metis 开发依赖须已安装；开发准备使用
`--ignore-scripts --bin-links=false`，避免触发个人安装。`SDK` 必须是新的隔离目录。

```bash
METIS=/absolute/path/to/metis-pi
SDK=/absolute/path/to/isolated-pi-1.5.0
PATCHES="$METIS/sdk-patches/pi-1.5.0"
git clone --depth 1 --branch v1.5.0 https://github.com/earendil-works/pi.git "$SDK"
cd "$SDK"
npm ci --ignore-scripts --workspaces=false --bin-links=false --no-audit --no-fund
npm install --no-save --package-lock=false --ignore-scripts --workspaces=false --bin-links=false \
  --no-audit --no-fund vitest@4.1.12 @xterm/headless@5.5.0 chalk@6.0.0 \
  @types/cross-spawn@6.0.6 @types/hosted-git-info@3.0.5 @types/semver@7.7.1 \
  @types/proper-lockfile@4.1.4 @types/ws@8.18.2 @types/ms@2.1.0 \
  @cloudflare/vitest-plugin@1.4.4 @silvia-odwyer/photon@0.3.3 \
  @vitest-evals/core@0.15.0 vitest-evals@0.15.0 fake-indexeddb@6.2.6 \
  @cfworker/json-schema@4.1.1 ata-validator@1.61.3 \
  @earendil-works/chord@1.5.0 @earendil-works/pi-durable@1.5.0 \
  @earendil-works/pi-env@1.5.0 @earendil-works/pi-evals@1.5.0
node "$PATCHES/prepare-build.mjs" "$SDK" "$METIS/node_modules"
for patch in "$PATCHES"/000*.patch; do
  git apply --check "$patch" || exit
  git apply "$patch" || exit
done
npm --prefix "$METIS" run build:pi-sdk -- "$SDK"
npm --prefix "$SDK" run check
npm --prefix "$METIS" run verify:pi-sdk
```

`prepare-build.mjs` 校验同版依赖、复制实体依赖与模型数据，并生成普通文件形式的工具入口。
未修改的 workspace 复用同版发布产物。额外测试依赖用于上游完整 check，属于构建环境。

`build:pi-sdk` 先核对 Git 基线，再重放六个补丁并比对源码，随后正式构建 ai、tui、coding-agent。
产物为 `assets/pi-sdk/pi-1.5.0.tgz` 和 `src/pi-sdk/distribution.json`；prepack 会检查两者与补丁是否一致。
发布前还应运行受影响的 SDK 认证、历史或 TUI 测试，以及 Metis 宿主与安装测试。
SDK check 若改写源码，须先同步补丁，再重新构建归档。

## 关键约束

- 三个 SDK 包的完整 dist、CLI bundle 和资源作为一组交付；局部替换容易混用模块实例。依赖使用实体副本。
- 历史格式、迁移、context edit、图片及持久化失败回滚沿用 Pi 1.5。
  正文 LRU 按序列化 UTF-8 字节计 16 MiB，普通读取复用至多 1 MiB Buffer；超预算单条完整读取并跳过缓存。
  树预览每条至多 200 个 UTF-16 单元。缓存预算与进程总内存分开，第三方长期持有的正文仍占内存。
- OAuth 登录标识用于执行中的归属检查，信任边界为本机凭据存储；账户、路由、headers 和持久检查点范围仍由调用方校验。旧凭据读取保持原样，原生登录或成功刷新时才写入连续性元数据。
- 补丁增删需同步 `scripts/pi-sdk.mjs`、`src/pi-sdk/artifact.mjs` 的数量校验，并重建归档和元数据。
  升级 Pi 时重新核对上游实现和版本约束，保留仍有必要的补丁。

## 撤回与清理

先暂停 Metis 安装/更新并禁用 `extensions/pi-sdk.ts`，或移除 Metis，避免自动安装入口再次触发。
将安装根目录的 `current-version` 恢复为当前 `metis-sdk.json` 中的 `previousRelease`，再重启 Pi。
恢复原版时应选择保留的官方发行目录。通常安装根目录为 `~/.pi/agent/install`，实际路径以 Pi launcher 为准。

卸载 Metis 会保留 SDK 快照；清理备份或中断遗留的暂存目录前，先确认相关进程已退出。
保持完整发行目录进行恢复，个人认证、设置、会话和 blobs 留在原处。
