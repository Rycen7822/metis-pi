# Condense TLA+ 模型

本目录保留需要长期维护的状态机约束和反例。现场数据、调参扫描、运行日志、TLC JAR 与一次性探针放在 `.work/`，不随测试发布。

TLC 检查有限状态模型，**不执行 TypeScript，也不证明整个实现正确**。修改相关行为时，需要同时核对模型及实际 TS/SDK 测试。

## 运行

需要 Node 和 Java 17+。已验证环境为 Java 21、TLC 2.19，JAR 来自官方 TLA+ 1.7.4。
从[官方 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)取得 `tla2tools.jar`；runner 不自动下载。

```sh
TLA2TOOLS_JAR=/absolute/path/tla2tools.jar npm run test:formal
# 可指定一个或多个模型
TLA2TOOLS_JAR=/absolute/path/tla2tools.jar npm run test:formal -- AsyncReaders PublicationTxn
```

每个配置使用一个 worker，最多 1 GiB heap、90 秒。生成的配置、完整日志和结果存入独立 `.work/formal-*` 目录。
缺 Java/JAR、解析失败、超时、未完成检查或未命中指定性质均算失败，不能以跳过代替通过。

此命令独立于默认 `npm test`、`npm run verify` 和安装流程；npm 发布文件不包含 `test/`。
配置与预期集中在 `condense/cases.mjs`，runner 生成 `.cfg`，不维护重复配置文件。
预期反例必须同时匹配退出码和指定性质；它们可能是故意移除保护、错误期待或成功路径见证，不等于已知产品缺陷。

## 模型对应的实现

下表中未写完整路径的 TS 文件均位于 `src/condense/`；SDK 补丁位于 `sdk-patches/pi-1.5.2/`。

| 模型 | 检查内容 | 对应实现 |
| --- | --- | --- |
| PressureGrid | 300k–1M 每 100k 一档的 675 组压力参数；容量余量、未饱和增长触发、原生容量线 | `budget.ts`、Pi 原生压缩 |
| OccScheduler | 60%/52%/72% 调度，等待耗尽、重入、保持期和复用次数取整 | `occ.ts` |
| ChainEconomics | 体积变小却更贵的反例；冷请求、三轮增长预测、摘要费、实际复用和发布间隔 | `rewrite-policy.ts`、`runtime.ts` |
| ColdBoundary | 冷请求许可绑定当前请求与来源，不能拿计划、取消或旧低命中冒充当前已冷 | `runtime.ts` 的费用检查参考约束 |
| PublicationTxn | 等待前捕获来源，发布时校验正文、策略和生命周期；无收益则保留原文 | `runtime.ts` |
| RetryLifecycle | 稳定引用、避免重复归档、候选拒绝结果的缓存与重试 | `indexer.ts`、`runtime.ts` |
| DeferredGuards | 延期重试不逐批重复完整校验，处理位置不越过缺口 | `runtime.ts` |
| AsyncReaders | 两个读取者不共用可变 buffer；来源失效、取消、I/O 失败和文件关闭 | SDK 补丁 0010 |
| WindowAdmission | 选中分支的尾窗口、有界 LRU、记录顺序与热窗口保留 | SDK 补丁 0010 |
| EncoderMemo | 排队快照、编码模式缓存键、仅复用计数、预算重算及有界 LRU | `token-estimator.ts` |
| LayeredCycles | 多代参数、工具、共享摘要和 Native 裁剪交错；来源、保护和摘要变化 | `runtime.ts`、`argument-history.ts`、`pruner.ts` |
| RecoveryCycles | 重复 ID 的独立参数和引用；持久化失败、恢复与旧缺口退出活动窗口 | `indexer.ts`、`runtime.ts`、`frontier.ts` |
| RenderAdmission | 容量等待不妨碍重验已有视图，也不允许新压缩绕过等待 | `runtime.ts`、`occ.ts` |
| SharedRetryWork | 同一无收益候选复用判断；有收益时仍做最终来源校验 | `runtime.ts` |
| NativeAuthorization | Native 完成或取消后的首次请求须等本地视图就绪 | `runtime.ts` |
| ActiveRanges | 同一投影的范围索引、唯一锚点、内容证明与最终来源校验 | `chain-range-prune.ts`、`runtime.ts` |
| BodyCoverage | 合成块 ID 相同不代表新成员已被摘要覆盖，未覆盖原文必须保留 | `chain-range-prune.ts` |
| VerdictEpoch | 来源、策略、保护、摘要或模型变化后重新判断收益；失败不缓存成拒绝 | `runtime.ts` |
| NativeFragments | 调用组被中途裁剪、重复 ID 与不完整参数/结果组 | `argument-history.ts`、`indexer.ts` |
| BranchAuthority | 共同前缀、分支私有引用及分页身份，防止跨分支串读 | `indexer.ts`、`query-tool.ts` |

## 压力与费用模型的边界

### PressureGrid 与 OCC

- PressureGrid 的 `threshold=0` 是 helper 非法输入对照；TOML 关闭值为 `false`。用量未知不允许自动付费。
- `maxBudget` 是触发评估的软门槛，不是整理后的总上下文目标。provider tokens、本地计数和归档字节不能互换。
- OCC 的 `ready` 是即时判断，不是持久阶段。剩余复用次数取整后须至少 11，不能用大于 10 的小数代替。

### ChainEconomics

- `funded` 检查即时回本参考策略；`gain-only` 展示只看体积的费用反例；`payback` 检查冷请求与后续三轮的总费用。
- 实现中的有界独立候选最多预测 32 次请求；本模型仍是三轮参考。文本/请求边界、32 轮策略和 SDK 行为由 TS 用例覆盖。
- 两侧起始缓存相同，后续各增长 2k/4k/6k tokens，目标命中率 98%，缓存量不超过上一轮长度。冷请求单列且不额外增长，压缩侧含摘要费后须严格更便宜。
- 摘要费立即记账；预计冷请求盈利只有收到有效回执后才能抵扣。首冷请求不能同时抵扣暖请求收益，也不计入之后三次 90% 实际命中。
- 再次发布仍须还清估算费用并有足够新工作。移除实际复用等待的对照应触发 `StableBeforeRewrite` 反例。
- 精确 2k/98% 场景检查 `ColdAndThreeRequestDebt` 和真正放行；变动增长场景检查 `CostDebtBound`，不要求任意增长都四次回本。大旧链还检查弱公平下最终放行，不能靠始终拒绝通过。
- token 数与收益比例使用整数缩放，费用放大 100 倍，还款向下取整以避免 TLC 溢出。实现另取 Pi 估算与本地计数的较小收益，模型不验证两者误差。
- 必要容量救急、原对照超容量和 Native 交接不保证费用下降。1M 输入场景用 1.5M 抽象容量把经济问题与容量问题分开。

不验证真实分词、价格可信度、工作分类、摘要事实、缓存写入费、TTL、路由变化、provider 账单或延迟。低缓存百分比本身不等于账单上涨，预测通过也不保证任务提前结束时回本。

### ColdBoundary

只刻画一次实际共同前缀失效，不假设所有 Native 完成都必然冷。请求与来源代次是模型辅助身份（ghost），不要求实现新增持久版本字段。已有视图在新工作延期时仍应保留，相关约束复用 RenderAdmission。

## 读取、缓存与发布模型的边界

| 模型 | 限制与假设 |
| --- | --- |
| AsyncReaders / WindowAdmission | 活性依赖弱公平、有限干扰和成功关闭。同步回退视为原子快照，缓存大小缩放，pinned 数据不计入 LRU；无公平性对照须出现时间性质失败。 |
| EncoderMemo | 使用确定性的符号计数，不验证 tokenizer。source/metadata 为模型辅助字段，不要求运行时缓存。 |
| RetryLifecycle | 区分候选事实与无关尾部变化，只缓存请求前的结构性拒绝。三轮符号集合不验证实际 64 项淘汰；归档修复在发布前，不覆盖外部删除已发布归档。 |
| DeferredGuards | 只计算完整来源复核次数，不代表毫秒或整个 flush 的 I/O 上限。按序结果不代替实际三请求并发测试。 |
| LayeredCycles | 最多六代、每代两个成员，假定归档成功。四层的 24 种顺序用于状态探索，不表示实际 pipeline 执行所有排列；gain、source、summary 均有抽象。 |
| RecoveryCycles | 分开探索归档、摘要、处理位置的失败及四个崩溃点。目录不允许隐藏原文；`obsolete-gap-need-not-block` 拒绝错误期待，不是产品缺陷，也不覆盖归档被外部删除。 |
| RenderAdmission / SharedRetryWork | 从有效共享视图或同一候选开始。Native 互斥由其他模型检查；允许遍历历史元数据，不代表恒定 CPU、内存或 UI 帧延迟。 |
| NativeAuthorization | 假定存活成员仍有收益且计数可用。Native 结束只是重验边界；取消后保留仍成立的证明，不额外模拟 `session_start` 掩盖事件缺口。 |
| ActiveRanges / BodyCoverage | 只计符号行查找；范围索引只在同一同步视图有效，不是 leaf 缓存。未覆盖原文保留但不自动合并旧摘要；派生输入重放约束独立检查。 |
| VerdictEpoch | epoch 是模型辅助身份，不要求全局运行时版本。模型不在 shape 内，切换模型时须清空旧判断。 |
| NativeFragments / BranchAuthority | 允许中途裁剪和更宽窗口再现；孤儿结果仍受 provider 结构清理，不保证模型可见。分支只抽象一种引用及有限分页，不含实际字节、bN 格式或任意分支图；`sourceEntryIds` 仍限选中分支。 |

发布校验与写入被抽象为一个同步动作。文件系统全部错误、任意长历史、无限调度组合、真实终端帧延迟、Windows 和多模态 provider 行为仍需实现侧验证。
