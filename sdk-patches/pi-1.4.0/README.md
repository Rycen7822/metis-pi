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
| `0004-preview-session-trees-without-history-bodies.patch` | `/tree` 使用元数据树和扫描时生成的短预览；正文、复制与全文查询显式按需读，查询可取消。 |
| `0005-preserve-hot-bodies-during-history-scans.patch` | 提供完整的一次性扫描读：只让 miss 不准入正文 LRU，保留已缓存热记录与原读取合同。 |

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

`0004` 在已经必需的 JSON 扫描中顺带提取每条消息至多 200 个 UTF-16 单元的文本预览、hasText 和工具调用 ID/位置，
单独存在 store，不让原 metadata API 带正文。短文本明确脱离大 parent，不能靠 slice 假装释放原文。
`getTreeSource` 绑定原 store，旧 `getTree`、完整树输入、显式 selected subtree 和完整复制继续可用。
message 搜索仍按原生 200 字符范围；custom 字符串、bash command、branch summary 的原全文搜索范围不缩短。
元数据查询按 8ms 工作片让出线程，新输入或关闭使旧查询失效；缺失正文明确报错，不冒充空结果。

`0005` 的 `getEntryForScan` 与普通 `getEntry` 共用解码和错误路径，已有缓存命中仍复用同一正文并更新 LRU；
只有 miss 不准入，不全局关闭缓存、不缩小 16 MiB 预算。内存会话及显式预加载保持原身份，缺失 ID 仍返回 undefined。
Metis 只在非 OCC 的原始 pending-turn 恢复指定 `cacheAdmission: "bypass"`；常规读取、状态恢复、树和 OCC 正文不变。
无新配置或环境门控；旧 SDK 缺少此能力时自动沿用普通读取，完整正文及源错误不被替换。

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
(cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run --maxWorkers=2 \
  test/session-manager test/session-context-edit.test.ts test/agent-session-stats.test.ts \
  test/tree-selector.test.ts test/agent-session-tree-navigation.test.ts test/interactive-mode-tree-navigation.test.ts \
  test/suite/regressions/9178-tree-during-compaction.test.ts test/suite/regressions/tree-during-streaming.test.ts \
  test/suite/regressions/2860-replaced-session-context.test.ts test/suite/regressions/3688-tree-cancel-compacting.test.ts)
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
`.work/pi-memory-baseline-20261103/implementation/`。这一组是 `0003` 阶段数据，不能替代下面的最终矩阵。

### 最终树与资源验收

`0000–0004` 的最终 32 个变更/新增源码、测试、构建文件与隔离重现结果逐一 `cmp` 相等。
最终 SDK 25 文件 313 项合同、完整 check、正式构建通过；真实 23911 条记录及模型投影仍与原版相等。
新树与旧 bundle 对照 102 个完整 ANSI 帧和 12 个搜索场景，保留标签、排序、折叠、完整复制、Unicode 和跨分支重复 tool ID。
真实新 CLI 的离线 PTY E2（shell 与后续请求）、E4（复制/草稿/提交）通过，剪贴板写入隔离 sink；没有调用真实模型。
这些测试只在临时 HOME 登记本地 Metis 源引用，不替换用户 SDK、配置或当前会话。

以下保留原早窗矩阵：固定 251 MiB 快照、6 次树开关及 36 次输入回显；RSS 是诊断 GC 后 5 秒观察值，**不是自然平台**，CPU 是该工作负载进程时间。

| 配置 | 旧基线 | 最终候选 |
| --- | --- | --- |
| pruning OFF，V8 heap | 381.90–381.95 MiB | 167.61–168.06 MiB |
| pruning OFF，RSS | 547.79–550.16 MiB | 330.11–520.95 MiB |
| pruning OFF，峰值 RSS | 771.27–794.14 MiB | 544.84–555.30 MiB |
| pruning OFF，CPU 均值 | 4.61 秒 | 3.86 秒 |
| pruning ON，V8 heap | 382.34 MiB | 181.04–181.10 MiB |
| pruning ON，RSS | 551.08 MiB | **628.49–632.02 MiB** |
| pruning ON，峰值 RSS | 781.61 MiB | 666.46–668.32 MiB |

**阶段解释更正：原 ON 的 628–632 MiB 只属于约 20 秒早窗，不能据此认定稳态退化。**
后续正确 SDK 包根、Pi 1.4.0/dark 主题的自然 ON 匹配复核中，旧/新退出前约 45 秒 idle RSS 为 559.92/368.55 MiB，
峰值为 806.92/658.13 MiB，shutdown RSS 为 645.58/455.70 MiB；候选在约 17 秒自然收缩。
这是一对整体改造前后对照，带双方一致的 major/reduce trace、无手工 GC；**不是 0005 单项收益或长期保证**。
OFF 有 2 次每臂数据；ON 旧基线 1 次、候选 2 次。输入是 Linux/tmux 回显往返，P95 候选有 7–11ms 离群，不能保证优于基线，
也未复现 24 小时 Windows Terminal 场景。源快照中的旧 subagent scope 在临时 HOME 无对应后台记录，两臂均出现同步警告；
故矩阵不证明真实 subagent 任务恢复成功，相关状态读取另由合同和真实历史对照验证。

仅在 `.work` 对候选试验了 semi-space 8/16 MiB；8 MiB 降低部分峰值，但持续工具/GC 停顿净收益证据不完整，
**不修改默认 GC 参数或用户启动器，不引入定时 force GC**。未做全库 verify、所有 PTY journey 或真实 provider/Windows 验收。
完整结果与失败修正、未采纳变体保留在上述工作目录；本阶段未安装用户 SDK。

### 一次性扫描缓存准入的验收（0005）

同机、同 251 MiB 历史，对照 `f30fd2d + 0000–0004` 与其加上本次 Root/0005 切片；每臂两次，ABBA 顺序，
6 次树开关、36 次输入后固定自然闲置 60 秒。实体包根/版本有断言，每例独立 HOME/JITI 缓存；无 expose-gc、trace、GC 或 trim。

| 主进程指标 | 普通准入 | 仅指定扫描 miss 不准入 |
| --- | ---: | ---: |
| shutdown 前峰值 RSS | 714.32–716.47 MiB | 640.63–641.94 MiB |
| 最后 30 秒自然平台 RSS | 406.71–409.06 MiB | 405.95–407.38 MiB |
| 自然闲置 heapUsed | 200.55–200.76 MiB | 187.62–188.24 MiB |
| 每次运行 CPU 总时间 | 7.44–8.16 秒 | 7.31–7.50 秒 |
| PTY 输入回显 P95 | 4.83–5.51 ms | 4.63–4.76 ms |

峰值均值下降约 74.11 MiB（10.4%）；**自然 RSS 平台基本不变**，不将 used heap 变化当成 RSS 释放。
同一实际工作集两遍扫描中，保留的 322 个热记录身份不变；随后当前投影恢复的真实 `fs.readSync` 从 152 次/约 1.19 MiB 降至 0。
这是文件读取调用量，不是操作系统磁盘块 IO、冷盘速度或任意大小上下文的保证。

完整 23911 条正文/树预览、172 模型消息、12634 索引、140 链、5079 用量及 1139 批次一致。
最近 SDK 合同 186 项通过，10 个真实 API e2e 按上游既有无密钥条件跳过；Root stock/patched SDK 各 174 项 Condense/OCC 合同通过。
SDK 完整 check、正式构建与 Root 类型/插件构建通过；增量应用后累计 32 个源码/测试/构建文件与测试候选逐一 cmp 相等。

启动连续开树保留一例 217.81 ms；一次只读 GC 诊断未复现，不能确定归因。另加一对自然 idle 30 秒再交互的控制中，
两臂树操作均约 60–115 ms、输入 P95 均约 4.94 ms；不声称树尾延迟改善，不用补例重算原 ABBA。
探针/原始数据/失败修正见 `.work/pi-rss-exploration-20261103/execution/`。本补丁仍**未安装用户 SDK**，没有长期 Windows 或真实 provider 验收。

## 后续维护与撤回

SDK 升级时先在新版本源码核对这些 owner/合同并重做最近验证；已上游解决的补丁删除，不强行保持旧 diff 可应用。
不要对不同 SDK 版本加 `--reject`/忽略错误，也不要绕过检查改生成 bundle。
未安装时撤回仅涉及本目录补丁；已安装自定义 SDK 后，必须恢复完整原版 SDK 并重启宿主，`/reload` 不能替换已加载的核心类。
个人配置、会话与缓存不属于补丁的回滚/清理对象。
