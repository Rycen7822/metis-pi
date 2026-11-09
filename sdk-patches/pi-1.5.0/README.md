# Pi 1.5.0 显式源码补丁

唯一基线：[Pi v1.5.0](https://github.com/earendil-works/pi/tree/v1.5.0)，
提交 `f9a26365568127461c47a07a37dcb42c140a3ac5`。不支持把本补丁集应用到1.4、预发布或其他版本。
MIT许可保留在[LICENSE.upstream](LICENSE.upstream)。以下实体依赖准备与构建用于Linux/WSL、Node ≥22.19。

**这些补丁修改SDK，不是扩展运行时猴子补丁。** 安装Metis或`/reload`不会应用它们；本目录不自动安装或替换正在运行的Pi。

## 顺序与owner

| 补丁 | 职责 |
| --- | --- |
| 0000 physical workspace bundling | 正式esbuild入口直接解析实体workspace，保留exports/subpath条件，不用软链接拼装依赖。 |
| 0001 visible row composition | 每个layout root只留上一帧可见行合成，继续执行组件render/布局/选区/复制/scrollbar；不缓存图片，保留1.5裁剪和扫描上界。 |
| 0003 lazy session bodies | JSONL元数据与UTF-8位置常驻、正文按需读；迁移启动/统计/计费/恢复/压缩等消费者，保留1.5持久化失败回滚与messageMeta。 |
| 0004 tree previews | 元数据树与有界短预览；完整复制、全文查询、取消、分页及旧getTree合同保留。 |
| 0005 scan cache admission | 扫描miss不准入正文LRU，命中仍复用/更新热记录；不把一次性扫描变成全局禁用缓存。 |
| 0006 OAuth login continuity | 原生登录建立归属标识，锁内刷新保留归属；认证来源和标识随同一次请求解析返回，压缩可区分正常刷新与重新登录。 |

编号0002不再交付：上游`0f21a3319`已提供assistant markdownSlots、Markdown块缓存和Text更新短路，
无需叠加旧正文复用实现。动态transform、thinking、streaming、主题与padding继续服从1.5原生owner。

文件正文LRU按序列化UTF-8字节计16 MiB，普通读复用至多1 MiB Buffer；单条超预算仍完整读，不假装截断或缓存。
预算不是进程heap/RSS硬限制；不持有长期FD，不加持久索引或内容hash。内存会话/显式预加载仍eager。
元数据API不带正文；独立树预览每条至多200个UTF-16单元，短字符串脱离大parent。
查询按8ms工作片让出事件循环；复制/显式旧历史读取、JSONL v3及旧格式迁移不缩减语义。

SDK `_appendEntry`保留失败后的store/索引/leaf回滚；后续条目不得指向未写入的parent。
保留1.5 context-edit branch summary、单FD fork、Windows pathsEqual、原生OAuth summary与图片修复。
Metis的`src/session-history.ts`集中探测元数据能力：stock1.5回退完整读取，补丁版使用按需能力；
这是同版stock/补丁形态，不是继续承诺1.4兼容。第三方长期持有完整正文仍会占内存。

## 隔离准备与应用

`METIS`是当前完整Metis开发目录（已安装精确Pi1.5依赖）；`SDK`必须是新建隔离目录，不能是用户安装目录。
所有npm安装禁用workspace/bin链接和脚本。配方复用同版发布产物给未修改workspace，不冒称重编译整个monorepo。

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
```

额外依赖来自1.5声明，包含上游完整check需要的schema benchmark类型；不是Metis新依赖。
准备工具校验同版ai/tui/coding-agent/schema，拒绝目标软链接，保留根工具链，复制缺失/nested实体依赖、
十个未改workspace的同版dist及模型数据，`.bin`用普通shell文件。正常无nested目录不再报错，其他I/O错误不吞。
1.5已用`scripts/package-files.mjs`代替shx，配方不再依赖shx或旧模型生成入口。

## 正式检查与构建

```bash
npm --prefix packages/ai run build:offline
cp -a packages/ai/dist/. node_modules/@earendil-works/pi-ai/dist/
npm run check
npm --prefix packages/tui run build
npm --prefix packages/coding-agent run build
(cd packages/ai && node ../../node_modules/vitest/dist/cli.js --run \
  test/models-runtime.test.ts test/oauth-auth.test.ts test/oauth-continuity.test.ts \
  test/openai-chatgpt-oauth.test.ts test/openai-codex-oauth.test.ts)
(cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run \
  test/model-registry.test.ts test/model-runtime-auth-options.test.ts test/model-runtime-credential-sync.test.ts \
  test/auth-storage.test.ts test/runtime-credentials.test.ts test/credential-print.test.ts)
(cd packages/tui && node --test test/layout.test.ts test/tui-alt-screen.test.ts test/wheel-scroll.test.ts)
(cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run --maxWorkers=2 \
  test/assistant-message.test.ts test/max-thinking.test.ts test/codemode-renderer.test.ts \
  test/session-manager test/session-context-edit.test.ts test/agent-session-stats.test.ts \
  test/cache-stats.test.ts test/cache-warmer.test.ts test/virtual-models.test.ts \
  test/interactive-mode-assistant-diagnostics.test.ts test/interactive-mode-compaction.test.ts \
  test/tree-selector.test.ts test/agent-session-tree-navigation.test.ts test/interactive-mode-tree-navigation.test.ts \
  test/suite/regressions/9178-tree-during-compaction.test.ts test/suite/regressions/tree-during-streaming.test.ts \
  test/suite/regressions/2860-replaced-session-context.test.ts test/suite/regressions/3688-tree-cancel-compacting.test.ts)
```

产物为ai/tui/coding-agent的`dist/`，正式CLI入口为coding-agent的`dist/bundle/cli.js`。
实际CLI必须包含本workspace代码；不能只核build exit0或只替换某个chunk。最终安装需一致交付包、TUI、
coding-agent、bundle和资源并重启宿主/worker；`/reload`不能换已加载核心。用户配置、历史、tokens和blobs不属清理对象。
显示版本仍为上游1.5.0，应明确称“1.5.0 + 本补丁集”，不是官方原版或新的官方版本。

## 本轮开发验证（2026-11-04）

本机Linux/WSL、Node24.15.0；不是Windows/Node22、用户现有终端或付费provider验收。
- SDK完整check通过，包含依赖/导入图/install-lock、类型和browser smoke。
- 正式两包构建通过，CLI bundle 82文件、约8.9 MiB。
- 五补丁从原版1.5干净重放后，29个变更/新增文件与本次构建源码逐一字节比较一致。
- 最近TUI 93项通过；SDK session/tree/assistant等260项通过，10项按上游既有无密钥条件跳过。
- 将新TUI与coding-agent完整dist放入实体测试包，Metis界面/复制/历史/压缩/OCC/MCP等418项通过，0skip。
- 真实新CLI的离线tmux E2/E4通过，使用临时HOME、本地provider与剪贴板sink；不触及用户桌面剪贴板。
- 129×59、两格侧边的布局实验ABBA每臂两例、各240帧：稳定行CPU均值132.85→4.02ms，
  所有行持续变化控制154.04→161.80ms（约+5.0%）。各样本最终完整ANSI帧一致；不是每帧/端到端/P95保证。
- 2049条、约39.3 MiB的Unicode历史：两臂模型上下文均9条、完整扫描和热正文身份一致。
  单次新进程实验、显式lab GC后新增heap约54.59→2.17 MiB；这不是自然RSS平台、24小时保证或整机速度结论。

脚本/原始失败/对照/退出码见`.work/pi-1.5-upgrade-20261104/`，不随运行时代码交付；
旧1.4数字不沿用，未做全量SDK测试、自然长期RSS/CPU或Windows图形/剪贴板验证，也未安装用户SDK。

## OAuth 登录连续性

`0006` 由 Pi 的认证解析和凭据存储维护归属，Metis 只消费 `source` 与 `oauthSessionId`。新登录生成新 ID，原生刷新在存储锁内保留当前 ID；跨进程通过同一凭据文件延续。原有凭据无需重新登录，读取也无需写回。

OAuth 凭据中的 `authSession` 将 ID 绑定到当前 access/refresh token 对。这里的 SHA-256 只用于识别带旧元数据的外部凭据替换，输入是单份凭据；账户、路由、headers 和 provider 的检查仍由请求消费者承担。它以凭据存储为信任边界，无法防止有权修改凭据和元数据的本机程序伪造状态。

登录和成功刷新才写入元数据；失败刷新保留原凭据。原版宿主或其他程序轮换 token 而未更新绑定时，下一次读取按新归属处理。此标识只用于执行中的结果提交，持久检查点的账户范围规则保持原样。

构建 `0006` 时先运行 `npm --prefix packages/ai run build:offline`，将完整 ai `dist/` 实体复制到隔离依赖中的同版 `pi-ai/dist/`，再构建 coding-agent。最终交付 ai、coding-agent、CLI bundle 及前五补丁的配套产物；当前会话需重启宿主。未安装时这些能力尚未在用户会话激活。

2026-11-09 在 Node 24.15.0/Linux/WSL 完成：SDK 完整 check、ai 与 coding-agent 正式构建、81 项 ai 认证/模型测试和 149 项宿主认证/存储测试通过；Metis 压缩、Condense、Goal 及压缩显示在原版与补丁版 SDK 下各 283 项通过，三组类型检查均通过。全部补丁从干净 v1.5.0 重放后，35 个变更路径与构建源逐字节一致。独立子进程刷新同一临时凭据文件的实验也确认了归属连续性；外部替换和同 token 重登会改变归属。以上为离线验证，未连接真实 provider 或安装用户 SDK。

## 维护与撤回

后续升级重新核owner/合同，再移植仍必要的能力；已上游覆盖的实现删除，不为保持旧diff应用而覆盖新修复。
未安装时撤回只涉及代码/补丁；安装后必须恢复完整同版官方SDK并重启，不能靠局部文件或扩展reload回滚核心。
