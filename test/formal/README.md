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
|AsyncReaders|双reader独占buffer、rewrite/store/leaf失效、取消、I/O失败与fd关闭|SDK补丁0010的store/manager|
|WindowAdmission|按选中分支路径尾窗口准入；LRU有界、不丢记录/顺序、热窗口不被全扫逐出|SDK补丁0010|
|EncoderMemo|排队快照、mode/after缓存键、仅复用计数、元数据/预算重新判断、有界LRU|`src/condense/token-estimator.ts`|

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
- 发布校验与写入被建模为同一同步动作；原生存储/文件系统所有错误、任意长历史和所有调度顺序不在有限边界内。
- 未收录人为时间单位的UI成本模型、重复纯公式模型、数百份临时cfg、TS探针、JAR及运行产物。
  本套件不提供真实终端帧延迟、Windows、多模态provider或无限规模证明。
