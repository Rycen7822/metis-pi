# Condense TLA+ 模型

本目录维护 Condense 核心状态机的长期约束和反例。现场数据、调参扫描、运行日志、TLC JAR 与一次性探针统一写入 `.work/`。

TLC 验证有限状态模型中的不变量、活性与预期反例。TypeScript 行为由现有 TS/SDK 测试覆盖，两类证据共同维护。

## 运行

需要 Node 和 Java 17+。已验证环境为 Java 21、TLC 2.19，JAR 来自官方 TLA+ 1.7.4。
从[官方 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)取得 `tla2tools.jar`，通过 `TLA2TOOLS_JAR` 指定本地路径。

```sh
TLA2TOOLS_JAR=/absolute/path/tla2tools.jar npm run test:formal
# 可指定一个或多个模型
TLA2TOOLS_JAR=/absolute/path/tla2tools.jar npm run test:formal -- AsyncReaders PublicationTxn
```

每个配置使用一个 worker，最多 1 GiB heap、90 秒。生成的配置、完整日志和结果存入独立 `.work/formal-*` 目录。
Java/JAR 缺失、解析失败、超时、检查未完成或指定性质未命中都会返回失败。

此命令独立于默认 `npm test`、`npm run verify` 和安装流程；npm 发布包通过 `files` 字段排除 `test/`。
配置与预期集中在 `condense/cases.mjs`，runner 按需生成 `.cfg`。
预期反例同时匹配退出码和指定性质，可用于验证故意移除保护、拒绝错误期待或展示成功路径。

## 模型对应的实现

下表中未写完整路径的 TS 文件均位于 `src/condense/`；SDK 补丁位于 `sdk-patches/pi-1.5.2/`。

| 模型 | 检查内容 | 对应实现 |
| --- | --- | --- |
| PressureGrid | 300k–1M 每 100k 一档的 675 组压力参数；容量余量、增长触发、原生容量线 | `budget.ts`、Pi 原生压缩 |
| OccScheduler | 60%/52%/72% 调度，等待耗尽、重入、保持期和复用次数取整 | `occ.ts` |
| ChainEconomics | 体积缩小却增加费用的反例；冷请求、三轮增长预测、摘要费、实际复用和发布间隔 | `rewrite-policy.ts`、`runtime.ts` |
| ColdBoundary | 冷请求许可绑定当前请求与来源，只接受当前实际冷请求的证据 | `runtime.ts` 的费用检查参考约束 |
| PublicationTxn | 等待前捕获来源，发布时校验正文、策略和生命周期；收益不足时保留原文 | `runtime.ts` |
| RetryLifecycle | 稳定引用、每项一次归档、候选拒绝结果的缓存与重试 | `indexer.ts`、`runtime.ts` |
| DeferredGuards | 延期重试复用完整校验，处理位置停在缺口之前 | `runtime.ts` |
| AsyncReaders | 两个读取者使用独立 buffer；来源失效、取消、I/O 失败和文件关闭 | SDK 补丁 0010 |
| WindowAdmission | 选中分支的尾窗口、有界 LRU、记录顺序与热窗口保留 | SDK 补丁 0010 |
| EncoderMemo | 排队快照、编码模式缓存键、计数复用、预算重算及有界 LRU | `token-estimator.ts` |
| LayeredCycles | 多代参数、工具、共享摘要和 Native 裁剪交错；来源、保护和摘要变化 | `runtime.ts`、`argument-history.ts`、`pruner.ts` |
| RecoveryCycles | 重复 ID 的独立参数和引用；持久化失败、恢复与旧缺口退出活动窗口 | `indexer.ts`、`runtime.ts`、`frontier.ts` |
| RenderAdmission | 容量等待期间重验已发布视图，新压缩在等待解除后进行 | `runtime.ts`、`occ.ts` |
| SharedRetryWork | 同一无收益候选复用判断；有收益时执行最终来源校验 | `runtime.ts` |
| NativeAuthorization | Native 完成或取消后的首次请求等待本地视图就绪 | `runtime.ts` |
| ActiveRanges | 同一投影的范围索引、唯一锚点、内容证明与最终来源校验 | `chain-range-prune.ts`、`runtime.ts` |
| BodyCoverage | 新成员必须被对应摘要覆盖；其余原文继续保留 | `chain-range-prune.ts` |
| VerdictEpoch | 来源、策略、保护、摘要或模型变化后重新判断收益；失败请求留给后续重试 | `runtime.ts` |
| NativeFragments | 调用组中途裁剪、重复 ID，以及参数/结果组的完整性要求 | `argument-history.ts`、`indexer.ts` |
| BranchAuthority | 共同前缀、分支私有引用及分页身份，维持分支隔离 | `indexer.ts`、`query-tool.ts` |

## 压力与费用模型

### PressureGrid 与 OCC

- PressureGrid 的 `threshold=0` 是 helper 非法输入对照；TOML 使用 `false` 关闭。自动付费要求有效用量。
- `maxBudget` 控制评估时机。provider tokens、本地计数和归档字节分别用于各自协议与预算。
- OCC 的调度状态由持久 phase 与即时 `ready` 共同表示。剩余复用次数取整后须至少 11。

### ChainEconomics

- `funded` 检查即时回本参考策略；`gain-only` 展示只看体积的费用反例；`payback` 检查冷请求与后续三轮的总费用。
- 实现中的有界独立候选最多预测 32 次请求，自动大 chain/共享机械整理预测 24 次；本模型使用三轮参考。实际预测分类、文本/请求边界和 SDK 行为由 TS 用例覆盖。
- 模型使用已知输入量、缓存和固定费率。实现中的 provider 用量基线、远端检查点冷预算、回执纠偏与跨档报价由策略、价格和运行入口测试覆盖。
- 两侧起始缓存相同，后续各增长 2k/4k/6k tokens，目标命中率 98%，缓存量受上一轮长度约束。冷请求单列且保持原长度，压缩侧含摘要费后须严格更便宜。
- 摘要费立即记账；有效回执确认冷请求盈利后才抵扣。首冷请求与后续三次 90% 实际命中分别记账。
- 再次发布要求估算费用结清并积累足够新工作。移除实际复用等待的对照应触发 `StableBeforeRewrite` 反例。
- 精确 2k/98% 场景检查 `ColdAndThreeRequestDebt` 和实际放行；变动增长场景检查 `CostDebtBound`。大旧链还检查弱公平下的最终放行。
- token 数与收益比例使用整数缩放，费用放大 100 倍，还款向下取整以避免 TLC 溢出。实现另取 Pi 估算与本地计数的较小收益，两者的误差由实现侧评估。
- 必要容量救急、原始视图超容量和 Native 交接以恢复容量为目标。1M 输入场景使用 1.5M 抽象容量，将经济问题与容量问题分开。

模型使用符号 token 与固定费率。真实分词、工作分类、摘要内容和 provider 协议由实现测试覆盖；价格可信度、缓存 TTL、路由变化、实际账单和延迟以运行环境与 provider 回执为准。缓存命中率是费用模型的一项输入。

### ColdBoundary

模型覆盖一次实际共同前缀失效；Native 完成后的缓存状态由实际 usage 确认。请求与来源代次是模型辅助身份（ghost），实现无需新增持久版本字段。已有视图在新工作延期时继续保留，相关约束复用 RenderAdmission。

## 读取、缓存与发布模型

| 模型 | 模型假设与实现侧补充 |
| --- | --- |
| AsyncReaders / WindowAdmission | 活性依赖弱公平、有限干扰和成功关闭。同步回退视为原子快照，缓存大小缩放，pinned 数据独立于 LRU；无公平性对照须出现时间性质失败。 |
| EncoderMemo | 使用确定性的符号计数，tokenizer 由实现测试覆盖。source/metadata 为模型辅助字段，运行时缓存只保存实际所需数据。 |
| RetryLifecycle | 区分候选事实与无关尾部变化，缓存请求前的结构性拒绝。三轮符号集合用于状态探索，实际 64 项淘汰由实现测试覆盖；归档修复发生在发布前，外部删除已发布归档属于运行维护范围。 |
| DeferredGuards | 统计完整来源复核次数。实际耗时、整个 flush 的 I/O 和三请求并发由实现测试与运行测量覆盖。 |
| LayeredCycles | 最多六代、每代两个成员，假定归档成功。四层的 24 种顺序用于状态探索；实际 pipeline 顺序、gain、source 和 summary 由实现侧验证。 |
| RecoveryCycles | 分开探索归档、摘要、处理位置的失败及四个崩溃点。目录存在时原文仍然保留；`obsolete-gap-need-not-block` 验证错误期待的反例。外部删除已发布归档属于运行维护范围。 |
| RenderAdmission / SharedRetryWork | 从有效共享视图或同一候选开始，Native 互斥由其他模型检查。历史元数据遍历的实际 CPU、内存与 UI 帧延迟由性能测试评估。 |
| NativeAuthorization | 假定存活成员仍有收益且计数可用。Native 结束触发重验；取消保留仍成立的证明。真实 `session_start` 与 Native 事件序列由实现测试覆盖。 |
| ActiveRanges / BodyCoverage | 统计符号行查找；范围索引只在同一同步视图有效。未覆盖原文继续保留，旧摘要合并与派生输入重放由实现测试覆盖。 |
| VerdictEpoch | epoch 是模型辅助身份。模型身份独立于 shape，切换模型时清空旧判断。 |
| NativeFragments / BranchAuthority | 覆盖中途裁剪和更宽窗口再现；孤儿结果遵循 provider 结构清理。分支模型抽象一种引用及有限分页；实际字节、bN 格式、分支图和 `sourceEntryIds` 的选中分支范围由实现测试覆盖。 |

发布校验与写入在模型中是一个同步动作。文件系统错误、长历史、调度组合、终端帧延迟、Windows 和多模态 provider 行为由相应实现测试与运行验证补充。
