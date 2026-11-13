# Condense TLA+ 核心模型

保留长期有维护价值的机制与反例，不收录一次性压力探针、现场数据、运行日志或历史调查报告。
模型不执行TypeScript，也不是整个实现的形式化证明；应与现有行为测试一起维护。

## 运行

需要Node及Java17+；已验证Java21、TLC2.19（官方TLA+1.7.4的`tla2tools.jar`）。
从[官方release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)自行取得JAR；不自动下载、不把JAR加入仓库。

```sh
TLA2TOOLS_JAR=/absolute/path/tla2tools.jar npm run test:formal
# 定向执行，可列出多个模型名
TLA2TOOLS_JAR=/absolute/path/tla2tools.jar npm run test:formal -- AsyncReaders PublicationTxn
```

每个配置单worker、最多1GiB heap/90秒；配置、完整日志和结果放独立`.work/formal-*`目录。
缺Java/JAR、解析失败、超时、未完成检查或未命中指定性质均失败，不会自动跳过报绿。
独立命令不加入默认`npm test`/`npm run verify`、插件安装或发布依赖；npm发布文件不包含`test/`。

## 保留范围与源码责任

|模型|持续保护的契约|源码owner|
|---|---|---|
|PressureGrid|300K至1M每100K一档，675组profile；level/headroom、未饱和delta、native严格容量线|`src/condense/budget.ts`；Pi原生compaction|
|OccScheduler|60/52/72%、请求内耗尽/重入、work/hold、near接管与复用次数取整|`src/condense/occ.ts`|
|PublicationTxn|等待前捕获；来源正文/策略/生命周期完整校验与发布原子边界；无收益延期|`src/condense/runtime.ts`|
|RetryLifecycle|恢复/修复后的稳定ref、无重复归档；候选级负向准入缓存、手动及生成后拒绝重试|`src/condense/indexer.ts`、`runtime.ts`|
|DeferredGuards|无收益重试不按批次重复复核完整来源；前沿不越过缺口，实际发布仍原子校验|`src/condense/runtime.ts`|
|AsyncReaders|双reader独占buffer、rewrite/store/leaf失效、取消、I/O失败与fd关闭|SDK补丁0010的store/manager|
|WindowAdmission|按选中分支路径尾窗口准入；LRU有界、不丢记录/顺序、热窗口不被全扫逐出|SDK补丁0010|
|EncoderMemo|排队快照、mode/after缓存键、仅复用计数、元数据/预算重新判断、有界LRU|`src/condense/token-estimator.ts`|
|LayeredCycles|多代参数/工具/shared层的24种顺序；派生形状、源/保护/owned摘要变更及Native截半成员|`runtime.ts`、`argument-history.ts`、`pruner.ts`|
|RecoveryCycles|重复ID仍有自己的参数/ref；多代持久化失败/恢复；Native退休旧缺口而不删回读记录|`indexer.ts`、`runtime.ts`、`frontier.ts`|
|RenderAdmission|容量等待不能阻止重验已发布视图，也不能放开新的压缩工作|`runtime.ts`、`occ.ts`|
|SharedRetryWork|无收益候选重用结论、不做发布级复核；历史成员先按当前锚点筛选；有收益仍须最终源校验| `runtime.ts` |
|NativeAuthorization|Native完成/取消后的首次请求等待本地视图就绪；只排后台任务不足以保证就绪| `runtime.ts` |
|ActiveRanges|活动范围按当前投影一次建索引；锚点唯一性、内容证明和最终源复核不能省略| `chain-range-prune.ts`、`runtime.ts` |
|BodyCoverage|同一合成块ID不代表覆盖了新增成员；派生输入重放保留未被表示的原文| `chain-range-prune.ts` |
|VerdictEpoch|收益正负翻转；策略、来源、owned摘要、保护和模型变化使旧结论失效；失败不作负向缓存| `runtime.ts` |
|NativeFragments|参数调用组中途裁剪、重复ID仍保留各自参数/输出；不完整组不能授权替换| `argument-history.ts`、`indexer.ts` |
|BranchAuthority|共同前缀与分支私有引用；目录重建和分页选择身份各自阻止跨分支串读| `indexer.ts`、`query-tool.ts` |

TLC输入和检查性质集中在`condense/cases.mjs`，runner生成`.cfg`，避免维护大量重复配置。
预期反例包括故意移除保护、错误期待和成功路径可达性见证；须同时命中退出码与指定不变量。
无公平性的reader对照须命中时间性质失败，不是产品死循环。

## 维护与边界

- 修改owner源码的契约时，先核对模型映射、场景预期和对应现有TS/SDK行为测试；不要只改模型让它变绿。
  模型自身通过不能证明实际实现仍满足它；本目录不与源码自动生成/绑定。
- PressureGrid的threshold=0只刻画helper失效输入，不代表TOML的关闭值。配置关闭使用false；用量未知不授权自动付费。
  maxBudget是软门槛，不保证压缩后总上下文低于它；provider用量、proxy tokens和底账字节不能互相替代。
- OCC的ready是瞬时布尔值，不是持久phase；取整后的剩余复用次数须至少11，不能用大于10的未取整值代替。
- Reader活性依赖弱公平调度、有限干扰和close成功；同步回退抽象为原子快照。缓存大小按小单位缩放，pinned不计入LRU。
- Encoder用确定性符号计数函数，不验证tokenizer；记录中的source/metadata是用于比较的ghost字段，不要求运行时缓存这些字段。
- RetryLifecycle区分候选/策略事实与无关tail/journal变化；只缓存请求前结构性拒绝，不缓存生成后失败。
  三轮内的符号集合不验证实际64项缓存淘汰；归档修复发生在发布前，不涵盖外部删除已发布证据。
- DeferredGuards只计算完整来源复核次数，不是毫秒或整个flush的I/O上界；允许共享准备视图和真正推进前沿的校验。
  按序结果抽象不代替真实三请求并发测试；冷恢复、JSON处理、模型窗口与全部压缩交错仍须实现侧验证。
- LayeredCycles最多6代、每代两个逻辑成员，假定归档成功；四层顺序是状态探索，不声称实际pipeline执行所有排列。
  source/summary是版本ghost字段，gain为符号profile，不验证tokenizer或自然语言摘要事实。
- RecoveryCycles独立探索archive/summary/frontier失败与4个崩溃边界；目录不是隐藏授权，退出活动窗口的缺口不永久阻塞前沿。
  `obsolete-gap-need-not-block`的反例拒绝错误期待，不是已知产品缺陷，也不覆盖外部删除已发布归档。
- RenderAdmission从有效的持久共享视图开始，区分容量线两侧和重算行为；Native运行/源变化的互斥由其他模型保护。
  SharedRetryWork只刻画同一候选的负向memo、最终检查次数及来源行比较，不证明跨候选失效；允许遍历历史元数据，
  不能解读为恒定CPU/内存或UI帧延迟。活动来源与策略变化仍须实现侧回归验证。
- NativeAuthorization假设存活成员仍有收益且本地计数可用；Native信号结束是本地重验边界，不授权新的付费工作。
  取消保留当前形状仍成立的见证，变化窗口须再验；恢复阶段不额外模拟一次session_start掩盖真实Native事件缺口。
- ActiveRanges只计符号行查找，不预测CPU/毫秒；索引仅限同一同步来源视图，不是leaf级内容缓存。
  BodyCoverage保留原文而不自动合并旧摘要；主SDK通常传新鲜来源，派生输入约束独立于主流程可达性。
- VerdictEpoch中的epoch是ghost身份，不要求新增运行时全局版本；模型身份不计入shape，模型切换必须清空旧结论，与源码一致。
  NativeFragments允许对抗性中途切点和更宽窗口再现；孤儿结果仍遵守provider结构清理，不承诺保持其模型可见性。
  BranchAuthority只抽象单类引用和有限分页，不含字节、bN格式或任意分支图；历史sourceEntryIds也是选中分支范围。
- 发布校验与写入被建模为同一同步动作；原生存储/文件系统所有错误、任意长历史和所有调度顺序不在有限边界内。
- 未收录人为时间单位的UI成本模型、重复纯公式模型、数百份临时cfg、TS探针、JAR及运行产物。
  本套件不提供真实终端帧延迟、Windows、多模态provider或无限规模证明。
