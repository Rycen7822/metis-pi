# Pi 1.4.0 显式源码补丁

这些补丁改动 **Pi SDK，不是 Metis 扩展运行时**。安装/更新 Metis、postinstall 或 `/reload` 都不会自动应用；当前运行的 SDK 不会因此改变。

基线：[earendil-works/pi v1.4.0](https://github.com/earendil-works/pi/tree/v1.4.0)，
提交 `4a080252f06caf63a525d7873c5d94d3c23887e0`。Node ≥22.19；以下准备/构建流程用于 Linux/WSL。
上游代码的 MIT 许可保留在 [LICENSE.upstream](LICENSE.upstream)。

## 补丁顺序与职责

| 文件 | 改动 |
| --- | --- |
| `0000-physical-workspace-bundling.patch` | 官方 esbuild 脚本通过 workspace 自引用/包入口解析依赖，不依赖 node_modules 软链接；保留 exports/subpath 条件，避免回退到旧 TUI 实体副本。 |
| `0001-reuse-visible-row-composition.patch` | 每个 layout root 只保留上一帧可见行合成结果；精确匹配源行、底层行、x、组件宽度和终端宽度。 |
| `0002-reuse-stable-assistant-markdown.patch` | Assistant 持有最近正文槽位的 Markdown 实例；文本、padding、streaming 一致才复用。 |
| `0003-load-session-bodies-on-demand.patch` | JSONL 常驻轻元数据及字节位置，正文按需读取；同步迁移 SDK 启动、统计、计费、模型恢复与边界预览消费者。 |

行缓存不跳过组件 render、布局、复制来源发布、scrollbar、选区、overlay 或图片处理；保留全宽快路径，不缓存图片行。
正文复用仍 invalidate，让动态 transform、宽度和主题样式重新求值；原生 token WeakRef 可能被 GC 回收，不改成强引用。
thinking、手动折叠、tool/error/abort/length、OSC133 和消息更新流程保持原生逻辑。以上两个 CPU 补丁无新增缓存预算。

`0003` 保持 JSONL 格式、旧分支、签名、图片、完整导出及迁移。文件会话常驻 header、白名单 metadata 和 UTF-8 byte offset；
正文缓存按序列化 UTF-8 字节计 16 MiB LRU，单条超预算仍可完整读取但不入缓存，**不是进程 heap/RSS 硬限制**。
同步读取另复用至多 1 MiB 工作 Buffer，大记录独立分配；不持有长期文件句柄、不加持久化索引或 hash。
`inMemory`/显式预加载继续 eager；`getEntry/getEntries/getBranch/getTree` 仍返回完整数据，不提供假正文或 Proxy。
新增 `getEntryMetadata/getEntriesMetadata/getBranchMetadata/getContextEntriesMetadata` 只提供事实；真正压缩和显式旧历史恢复仍读必要正文。
`createBranchPreview` 保留完整历史位置，不把已被摘要的旧目标丢掉；预览不改原分支或文件。

Metis 已通过 `src/session-history.ts` 做一处能力适配：stock SDK 回退完整读取；打补丁 SDK 先按 metadata 选择再解码必要记录。
第三方若继续调用并长期持有完整历史，仍会占内存；`0003` 不会自动替它们卸载正文。所有补丁均无扩展运行时猴子补丁。

## 隔离准备与应用

使用已有完整 Metis checkout 及其 Pi 1.4.0 开发依赖。`METIS`、`SDK` 必须是**绝对路径**，SDK 目录必须是新建的隔离源码副本，不能指向安装目录。
准备工具只读取 Metis 的依赖，不修改它们；SDK 依赖全部为实体副本，`.bin` 使用普通 shell 文件，不创建软链接。

```bash
METIS=/absolute/path/to/metis-pi
SDK=/absolute/path/to/isolated-pi-1.4.0
PATCHES="$METIS/sdk-patches/pi-1.4.0"
git clone --depth 1 --branch v1.4.0 https://github.com/earendil-works/pi.git "$SDK"
cd "$SDK"

# 禁用 workspace/bin 链接及安装期脚本；不在这里运行普通 workspace npm ci。
npm ci --ignore-scripts --workspaces=false --bin-links=false --no-audit --no-fund
npm install --no-save --package-lock=false --ignore-scripts --workspaces=false --bin-links=false \
  --no-audit --no-fund vitest@4.1.11 @xterm/headless@5.5.0 chalk@6.0.0 \
  @types/cross-spawn@6.0.6 @types/hosted-git-info@3.0.5 @types/semver@7.7.1 \
  @types/proper-lockfile@4.1.4 @types/ws@8.18.2 @types/ms@2.1.0 \
  @cloudflare/vitest-plugin@1.4.4 @silvia-odwyer/photon@0.3.3 \
  @vitest-evals/core@0.15.0 vitest-evals@0.15.0 fake-indexeddb@6.2.6

node "$PATCHES/prepare-build.mjs" "$SDK" "$METIS/node_modules"
for patch in "$PATCHES"/000*.patch; do
  git apply --check "$patch" || exit
  git apply "$patch" || exit
done
```

准备工具验证三个已发布 SDK 包为 1.4.0，拒绝目标依赖树中的软链接，保留已经安装的根工具链。
它复制缺失运行依赖及 SDK 内的必要 nested 依赖；**未改的五个 SDK workspace dist 复用同版本发布产物**，不是声称本次重编译了整个 monorepo。
AI 发布包的模型 catalog 数据也复制到源码的 ignored 数据目录；不修改 `models.generated.ts`，不读取个人模型配置。
上面补齐的额外依赖用于上游完整 check/最近测试，全部沿用 v1.4.0 的声明或锁文件版本；不改变 Metis manifest/lock。

## 正式构建与检查

```bash
cd "$SDK"
npm run check
npm --prefix packages/tui run build
npm --prefix packages/coding-agent run build

(cd packages/tui && node --test test/layout.test.ts test/tui-alt-screen.test.ts test/wheel-scroll.test.ts)
(cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run \
  test/assistant-message.test.ts test/max-thinking.test.ts test/codemode-renderer.test.ts \
  test/suite/regressions/8611-thinking-toggle-pending-bash-output.test.ts \
  test/suite/regressions/4167-thinking-toggle-pending-tool-render.test.ts \
  test/suite/regressions/10285-mcp-tool-renderers.test.ts)
```

修改包的产物分别在 `packages/tui/dist/`、`packages/coding-agent/dist/`，正式 CLI 入口为后者的 `bundle/cli.js`。
构建脚本必须把当前 workspace TUI 放入真实 CLI bundle；不能用独立 renderer 复制品或“build exit0”代替确认。

**此流程不安装。** 后续安装必须单独获准并交付一致的 TUI、coding-agent、bundle 与资源，不能只替换某个 chunk 或复制 dist 后仍使用旧依赖。
自定义产物仍显示上游版本 1.4.0，应明确标记“1.4.0 + 本目录补丁”，不得冒称官方原版或新官方版本。

## 本次验证证据与边界（2026-11-03）

环境：本机 Ultra 7 265K、Linux/WSL、Node 24.15.0；正式构建 81 个 bundle 文件，约9.0MiB。
SDK 全仓 `npm run check`、两包正式构建、89项 TUI 测试、26项 SDK UI 测试通过；正式 bundle 下68项 Metis UI/入口/复制/历史合同通过。
与真实原版 bundle 对照，32个帧/边界场景的完整行、布局、终端写入、选区一致；96组 Markdown ANSI 与96组完整复制 product 一致。
临时探针、fixture、原始性能数据在 `.work/pi-resource-audit-20261103/`，不作为运行时代码交付。

每组每臂2次新进程，顺序为原版/候选/候选/原版，150帧、32ms节奏；表为 CPU 时间均值，不是整台电脑CPU占比。
对照双方加载完整 SDK API，预对齐模块图的数据另行保留，不混入最终结果。

| 局部场景 | 原版 CPU ms | 候选 CPU ms | 变化 |
| --- | ---: | ---: | ---: |
| 129×59、左右2格、稳定历史重绘 | 615.19 | 132.35 | −78.5% |
| 同布局、可见行持续变化控制 | 1054.80 | 1020.73 | −3.2% |
| 15079字节正文不变，仅工具参数更新 | 1911.63 | 1038.28 | −45.7% |
| 744字节正文不变，仅工具参数更新 | 451.57 | 375.54 | −16.8% |
| 15079字节正文持续变化控制 | 1953.71 | 1965.68 | +0.6% |

变化正文控制组 CPU 基本持平，不能声称所有输入零开销。输出字节数与完整结果对照均通过；不将局部收益外推到整个 Pi。
本轮没有证明大幅持久 RSS 节省，没有删历史/签名/图片或调 GC；未重现旧24小时 Windows Terminal 慢输入，也未做 Windows/Warp 真实图形/剪贴板传输验收。

### 按需历史补丁的开发证据

同一份 251 MiB / 23911 条历史，所有 entry、branch、context provenance 与模型 messages 对照原版一致；
追加、分支导出、v1/v2 迁移、UTF-8 offset、CRLF/尾行、unknown entry、大 header fallback、缓存淘汰及超大条目通过。
SDK 23 文件 287 项定向合同、完整 `npm run check`、正式 TUI/coding-agent 构建已通过；未发真实 provider 请求。
`0000–0003` 在上游实体源码副本依次应用，全部 28 个变更/新增文件与测试源码 `cmp` 一致。

实际隔离 CLI（CPU 补丁基线 + Metis1194b04，对照当前四补丁 + Metis61d1f3c）仍保留所有必要索引和状态。
一组同快照控制：GC 后 V8 heap 380.82 → 163.67 MiB、主进程 RSS 550.26 → 475.38 MiB、峰值 RSS 717.36 → 476.39 MiB。
这是完整 SDK/Metis 候选合计，**不能将差值归到单个补丁，也不是当前宿主实测或 24 小时运行保证**；
readiness 有单次异常，不把最快一次或轮询时间当输入 P95。额外 Python daemon 两臂均启动，未运行 agent 任务。

同步读 Buffer 的独立全历史扫描：23911 次 / 251.18 MiB 分配降为 11 次 / 17.69 MiB，读循环 493–561 → 459–467 ms；
没有证明该 Buffer 单项减少 CLI RSS 或冷启动时间。临时脚本、原始对照和已修正的失败保留在
`.work/pi-memory-baseline-20261103/implementation/`。`/tree` 懒读和最终键盘/CPU 矩阵尚未完成，本阶段未安装。

## 后续维护与撤回

SDK 升级时先在新版本源码核对这些 owner/合同并重做最近验证；已上游解决的补丁删除，不强行保持旧 diff 可应用。
不要对不同 SDK 版本加 `--reject`/忽略错误，也不要绕过检查改生成 bundle。
未安装时撤回仅涉及本目录补丁；已安装自定义 SDK 后，必须恢复完整原版 SDK 并重启宿主，`/reload` 不能替换已加载的核心类。
个人配置、会话与缓存不属于补丁的回滚/清理对象。
