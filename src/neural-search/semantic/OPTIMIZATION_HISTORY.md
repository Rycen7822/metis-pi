# Semantic 优化历史

更新：2026-11-09 10:10（UTC+08:00）。本轮开发基线 `c2af8e8`；Bekko 文档并行与 JSON 映射已接入源码。发布资产和安装激活另行处理。
Native 基线资产位于仓库根目录的 `external/semantic-engine-candidates/ae3f9ee/`。

本文是纳入 Git 的优化历史唯一维护入口，运行契约以 [README](README.md) 和源码为准。各轮原始报告、benchmark 数据和私有原型保存在 Git 忽略的 `.work/` 中，只有本文随仓库分发。证据链接仅在保留这些资料的本地副本上可用，克隆仓库或网页阅读时原始文件可能缺失。

本文只记结论：已采用什么，未采用什么及原因，哪些尚未验证。时间线、失败样本和复现命令见各轮报告。提交层面核对过 63 个相关路径提交和 9 个无文件变更的验证 checkpoint，来源与覆盖范围见 [E29]。

## 1. 当前结论与比较口径

### 最新进展

| 方向 | 当前证据 | 状态 |
| --- | --- | --- |
| Bekko 文档并行与 JSON 映射 | 两个大文档 scope 相对正式串行版快约 30%–36%；小范围首次调用约快 4%，暖模型收益不一致 | 用户接受波动范围后采用，见 2.4。[E68] |
| 首 QKV 批内行复用 | 完整 EverTrace 的 FP16 表示与分数逐位相同；正常 CLI 两对平均快 2.018%，daemon HWM 增约 6.50MiB | 尚未采用，见 3.3。[E57]、[E58] |
| 七层 GeGLU producer | 健康时钟下消费活动段快 1.792%，5/6 轮更快；A/A 波动约 ±1.6%，短场景波动大 | 未采用。arena 峰低 2.91MiB，这是实际的资源收益。[E61] |
| 原 local banded | 健康时钟下六轮全部更快，消费活动段快 2.133%；表示和分数仍会变化 | 保留为小幅候选，需单独取得数值资格后才能替换原算术。[E62] |
| local exact | 恢复原值，但消费活动段慢 0.329%，只有 2/6 轮更快 | 缺少加速依据，未采用。[E60]、[E62] |

E64–E67 的 Native 候选均未采用。E63 提出的五条线均已做成独立小实现并完成有限判别：R4 跨 query 共享 K 在完整 Native 中接近零；真实 RN 复用使 arena 峰增加 11.01MiB；投影 prepack 与批量 F16C 没有稳定的完整收益；LIBXSMM 小形状只测了首用门，长期摊销留待 3.9–3.11 的整库与归因验证。[E64]

分词版本升级和有界 worker 池已随 `7ef8e44` 采用。全量或权重 FP16、W8A8 质量恢复、Gigatoken 和 ZG 的两条原型已由用户叫停；历史研究须重新立项，才能成为执行计划。

**LIBXSMM 整段 JIT（E67）已停用。** 大形状的真实 JIT 与 F32/F16 对拍均通过。在 1515 行真实输入上，它比旧 tile16 平均快 5.781%，但仍比原 MLAS 平均慢 4.693%；2048 合成边界慢 20.651%，各轮方向摇摆。该方案未进入 Native 和整库。E65 那轮 8.33% 的归因更正见 E66（3.10）。局部和组件数字只适用于局部，外推到整库需另行验证。按用户决定，这一版停用，路线到此结束。[E67]

### 口径

- 耗时的负数表示变快。组件、完整 Native、正常 CLI、暖命中、空索引首建分开比较，百分比只在同一轮内比较。
- A/B 指候选对控制；A/A 指同一实现的两份副本对照；H 指完整索引命中。Native 指模型前向；“消费活动段”从创建/query 算到 MaxSim，包含准备与转换，计入的是组件内耗时而非端到端墙钟。
- 当前边界：完整 scope、同分稳定排序、最多四窗/2048 tokens、每请求四计算线程、128MiB Native arena、最多三个活跃请求。磁盘预算 256/512/1024MiB 只改变磁盘占用，内存与线程限制维持原值。产品默认值为 512MiB，1024MiB 是用户自行配置的值。
- MaxSim 的“Q4”指四个 query 行共用同一块，与 INT4 量化无关；“四窗/八窗”指独立序列的微批大小。
- 未采用的原因分为四类：实测更慢、收益波动、质量或工程资格不足、尚未测。这些结论只对本机和当时的实现成立。
- E60 发现 WSL 在 `tick=9167` 时钟下 MONOTONIC 约为 RAW 的 11/12；用户停用 timesyncd 后回到 `tick=10000`，E61/E62 是在健康时钟下的重测。固定时基比例无法解释旧版的 31.5% 漂移，旧的绝对秒数无法直接迁移到新环境。[E60]–[E62]

## 2. 已采用的实现

### 2.1 初版基础与架构选择

初版核心 `c18157a`（10-28）和宿主入口 `f802d6d`（10-28）定下了整条链路的形态。后续工作都在这一骨架上展开，因此归入既有骨架，而非新增优化。[E29]、[E30]、[E32]

链路为 Rust CLI → 进程内 C ABI → 固定的 ORT CPU/MLAS 加自定义核，推理在进程内完成，没有常驻的 Python/PyTorch。模型分工：LateOn-Code-edge 负责代码，Bekko128 负责基础检索；全范围语义、BM25、符号候选和原有融合排序都保留。Bekko 代码预筛、Top32 再交给 LateOn、RRF 和用 ANN 替代全库，均未采用。`semantic` 是第三种 action，与 find/grep 和 frecency 重排并列。

Bekko 侧采用 INT8 逐行权重加 scale 查表、FP32 累加与归一化，AVX2 按 1024 行分块扫描。早期的“约 5×”只统计重排微核，未包括整次检索耗时。
LateOn 侧在进入 Native 之前完成 embedding 与 LayerNorm 预处理，并做投影折叠、RoPE/pack、residual/LN、GeGLU 和 MLAS 预打包。global 强制走 CPU Flash，条件未满足时直接报错；local 只计算窗口，禁止静默退化为完整的平方矩阵。

资源与恢复：owned-rg 线程数有上限，额外的 OneDS 线程已关闭；激活和自定义 scratch 归入 128MiB 硬 arena，期间修复过 BFC 额度减法下溢。fresh-assets 只写临时资产，普通索引保持原样；资产事务按可验证的 owner 回收已死进程的残留，活进程和未知文件原样保留。arena 限额只约束 Native 分配，进程 RSS 还受其它因素影响。

早期的 RTX5090/NextPlaid 加 FP16 精排副本只做了可行性审查。“十多 GiB”是特定语料、双表示与重建代并存时的估算值，既非 sgrep 的最低需求，也未在本机实测。当时的 sgrep 每片段缓存 256 维向量，默认 256MiB 索引；“无需预建库”仅表示可以跳过预建，embedding 仍须存储。CPU v4 后来取代了 GPU 设想；单 CLI、无 daemon、仅 256MiB 都已是历史状态。[E30]

### 2.2 缓存、暖检索与排名

| 实现 | 提交 | 结果与边界 |
| --- | --- | --- |
| 完整索引无损压缩 | `424ded4` | 对既定 FP16 表示无损，分数保持原值。无损指相对 FP16 表示而言，与 FP32→FP16 转换无关。[E01] |
| 词法 key 只计费一次 | `22f71a8` | 仅首次插入时计入 key 内存；零分、负零和原排序语义保留，属于资源与数值修复。[E29] |
| 三档磁盘预算、可信配置快照 | `bc8b517`、`b9bae67` | 同一请求读取同一份不可变 TOML 快照及文件身份；非法档位和读取期间的变化会被拒绝。[E29]、[E32] |
| Format08 词法单存、有界映射 | `4992a4c` | 词频只存在 record 中，全库 dictionary/postings 不再单独驻留；仍读取并验证 Format07，以有界窗口处理，处理完释放 PTE。[E01] |
| 写入增长时 LRU 腾空间 | `6cddb3a` | 增长时重新计量并准入，回收闲置的完整索引；活跃 reader 与原子替换受保护。容量不足时改走完整流式计算，且档位保持原样。[E01] |
| 向量只解码、校验一次 | `568a8e0` | 有限值与 codec 验证并入评分；坏缓存恢复时复用 query。CRC 与源码验证保留。固定 panel 上 RepoQA/CoSQA 的 P50 分别下降约 13%/21%。[E01] |
| 固定 BPE 加载 | `eda0682` | 去掉动态 ModelWrapper 分派；token、角色与 query 限长保持原样。[E02] |
| 有界 decoder 与批量位拆包 | `e6ce124` | scope/pass 复用 Zstd DCtx；八个 FP16 值成组恢复，兼容 raw/packed 及 Format07。与 BPE 合测时 panel 约降 18%/22%，两项收益只计一次。[E02] |
| source 摘要 scratch、lease 聚合写 | `ec55820` | 跨文件复用 64KiB 缓冲；lease 有界序列化后一次性 write_all。锁、sync 和原子发布保持原样。CoSQA 有收益，RepoQA 总体 P50 没有改善。[E03] |
| 完整 record 并行扫描 | `8f65fc7` | 最多四线程动态分配解码、验证、MaxSim 和词法计算，与 ORT 共用线程池时避免叠加；小规模域走串行。2570 个 record 的三个真实请求快约 42–45%，这是局部数字，总体 P95 需另行测量。[E04] |
| metadata/DF 首遍并行 | `674b02c` | 原双遍框架使用有界批次和 DF 数组；正常 Format08 主路径后来已融合，因此无需再做一遍首遍。[E06]、[E10] |
| 暖路径与词法准备归一 | `bc1f067`、`add2e1a` | 合并 metadata/DF/tf/评分，去掉两次 source 快照和两遍完整 metadata 解析，复用 query、资产和统计，并统一 IDF 规则。旧格式与宽几何回退、零分处理和最终源码校验保留。[E10]、[E29] |
| 有界排名、AST 边界复用、输出早拒绝 | `63e6e91` | 已知结果无需反复全量处理；同分顺序保持，输出下界只用于安全的早拒绝。全部同分（all-tie）场景仅在部分面板上更快。[E12] |
| MaxSim Q4 融合、decoder 输出复用 | `7d4e0ad` | 共享文档加载，每个 query 行的累加顺序保持原样；每个 worker 只保留一窗缓冲。即已采用的 T2/T4。[E13] |
| 无损 SIMD 解包 | `972c61f` | 加速恢复原 FP16 位值；scalar 路径、有限值检查和损坏回退都保留。这是无损解包，与低比特量化无关。[E14] |
| 完整 source digest 并行 | `9431515` | 通用规模下有界并行，仍验证全部内容，未改用 mtime 或 benchmark 身份。早先依据同 binary 比较的 T1 否定已撤回。[E13]、[E14] |

### 2.3 共享服务与启动

| 实现 | 提交 | 结果与边界 |
| --- | --- | --- |
| 宿主版本化 semantic 入口 | `f802d6d` | deferred 发现、protocol1、参数与结果校验、预算和完整排名前缀；find/grep 保留，取消时收完整进程组，失败时直接报错，由调用方决定是否回退。[E29]、[E32] |
| 跨 scope 复用懒加载模型服务 | `f836616` | 三个活跃请求、32 项 FIFO，超出的请求排队等待；每请求最多四计算线程，默认 300 秒无业务请求后退出。Native encode 未必能全部同时执行。[E05] |
| 旧服务握手与安全恢复 | `da45acb` | Ready 之前请求只排队，之后才提交或重放；按协议处理旧版本、崩溃和帧错误。[E05] |
| fd 就绪等待替代固定轮询 | `9015950` | owned-rg 与 listener 改为等待 pipe、pidfd 和唤醒事件；限额、取消、旧内核回退和清理逻辑保留。[E06] |
| 固定 WordPiece、ready 通知、读取缓冲 | `5f8ba8c` | Bekko 固定加载；自有 daemon 一次性发送 ready 通知，并聚合小消息。JSON 缓冲的冷启动收益没有单独证实。[E07] |
| 自动准备与复用共享资产 | `3565cab`、`4571e29` | 首次安装或更新时自动准备；合格模型复用已下载的文件；临时性下载失败会重试。这是交付改进，与前向加速无关。 |

### 2.4 表示、Native 前向与分词

| 实现 | 提交 | 结果与边界 |
| --- | --- | --- |
| local PV 沿值维 SIMD | `6ac7cec` | 原 key 顺序、最终除法和 FP32 输出都保持原样；有限首建范围内约快 1.35%。与后来的 PV2/PV4 跨 query 共享 V 是两回事。[E08]、[E24] |
| FP16 预处理表、取行扩为 FP32 | `872dc73` | 表从 49.19MiB 降到 24.59MiB，省去整表 FP32 副本的生成；backbone 仍为 FP32。**存在轻微的质量损失，经用户接受后采用**；当时配对 CoSQA Hit@5 为 389/500→388/500。[E09]、[E25] |
| SIMD finite 分类共享 | `33b5882` | 输出与 MaxSim 边界共用同一判定；scalar 路径、异常分类和部分输出保护保留，精度保持原样。[E11] |
| GeGLU 使用公开 ORT Erf | `01773c2` | 在原 pool 中执行，required-ops 包含 Erf/MHA；新算术身份把缓存与旧版隔离开。1100 题指标与已接受的 FP16 基线相同，但与旧 std::erf 的结果在逐位上有差异。[E11] |
| Residual/LN 四行 SSE、短行由 caller 执行 | `8b7a376` | 每行保持原列归约顺序；CoSQA 完整首建两对约快 6.45%。与通用 T3、后续 LN8 分属不同实现。[E16] |
| 四窗分段微批、共享 flat 线性计算 | `bba4002` | 四窗 / 2048 tokens，ABI3 / manifest4；RoPE、local、global 严格分段。全部 12690 窗的 FP32 与载荷相同，正式首建 136.184→119.005s。[E18]、[E19] |
| arena 几何增长 | 随 `bba4002` | 在同一 128MiB 上限内，修复了长度重排导致的碎片与分配失败。单独面板未见稳定提速，采用依据是资源正确性。[E18]、[E19] |
| Run 期间 spin，末次 Run 立即停止 | `ae3f9ee` | 由 Env mutex、活动计数和 RAII 处理取消与异常；空闲时停止持续 spin。完整 Native 100.114→88.792s，正常首建 111.480→98.399s；值与载荷相同，CPU 累计 +0.93%，暖 H 无稳定收益。[E23] |
| tokenizers 0.23.1 + 模型生命周期分词池 | `7ef8e44` | query 与 doc 都在四个 worker 上分词；drop 后 join，释放 BPE TLS。有界首窗准备、大批串行、按源报错，Native 分组保持原样。组合分词首遍快 37.83%，正常 CLI 两对快 3.56%，CPU 与 RSS 代价见 3.1。[E52] |

本轮采用 Bekko 请求内文档并行与 JSON 只读映射。少于 8 个唯一块时逐块直接处理；大范围每批最多 4 块、64KiB，由最多 3 个 worker 加 caller 编码，共享一份模型。长单块和单块尾批仍直接处理。按 source 顺序消费结果，成功计数后完成 record；写入降级立即释放事务，继续完整评分。JSON 沿用原解析器，解析完释放映射，表示和算术保持原样。[E68]

最后一轮 EverTrace/Pi 文档范围对正式串行版分别快 30.46%/36.30%。JSON 增量使小 1/4 块首次调用对上一候选快 3.33%/5.87%，暖模型没有一致改善；Pi 文档范围相对上一候选慢 2.47%，用户接受这一取舍。数字只覆盖 Bekko 文档检索，与 LateOn 全代码仓库首建分开。缩小 TextScan scratch 的试验已撤回：内核与空间改善未转化为稳定的真实 H 收益。[E68]

“逐位相同”仅与当时的基线比较；此前已接受的 FP16 存表与 Erf 误差依然有效。
无损 codec 与 SIMD 解包还原的是原 FP16 位值；最初的 FP32 embedding 转为 FP16 仍是有损的。

### 2.5 编辑重建、恢复与交付

| 实现 | 提交 | 结果与边界 |
| --- | --- | --- |
| 同 scope 复用未改动的 record | `f5447f4` | 在原有校验和事务之下复用未改动的代码文件；复用仅依据文件身份，mtime 与跨仓库复用都排除在外。text 与 Bekko 走另一条路径。缺少 raw 路径身份或唯一映射时直接退出复用。 |
| 请求内 query/统计/相同 chunk 复用 | `dffaee0` | 被编辑的文件仍会拆分，只跳过归一化文本相同的 forward。八对编辑 case：401.031→236.101ms；50-chunk 文件 1104.485→59.616ms，这些都是非首次建库的场景。[E15] |
| reader lease 原子公布 | `2a7bece` | 修复 JSON 写到一半后缓存长期失效的问题：持锁暂存、sync，再原子公布；只回收可证明已死亡的 owner，活 reader 与 open-deleted 代仍计费。[E29] |
| Native 相邻库依赖 | `f339eb1` | 在 CMake 安装阶段解决依赖，开发树不再承担回退。旧 P6 stage 仍含 SONAME 软链，无法直接满足当前实体副本的交付要求。[E29] |
| 协议空结果 | `961d44c` | 空列表是合法结果，直接返回空结果。[E29] |
| 命名与责任归属 | `2c562d4` | 统一 source 快照、record 扫描与解码、排名和重建的 owner。这是结构整理，未引入新算法，也未计入提速。[E29] |
| 初版质量、资源与宿主资格 | 9 个 checkpoint，`11516f5` 收口 | 覆盖多语言、长窗、mixed 质量、cgroup、恢复和 P7 分层。无文件变更的 checkpoint 仅作验证节点，未计入九轮算法优化，后来的 Native 结果保持有效。[E29]、[E32] |

旧版“改一行就重编全库”确有其事：6319 块的对照中，耗时从 47.52s 降到 0.640s，重编块数从 6319 降到 1，但完整评分仍要处理 6319 块。先靠 record 复用、后靠 chunk 复用逐步改善；改善并非来自把预算调到 1024MiB；在所有编辑和仓库上的一致性也未得到保证。[E15]、[E30]
`d7b701d`、`562b8d4`、`9eb5f02` 只整理文档和依赖说明，未计提速。[E29]

## 3. 近期研究链：关键转折

### 3.1 分词：版本与池化已采用，容量与替代库仍待定

线索来自 ZG 的 #332。它复用的是配置中的 tokenizer，并非新的 BPE；促成后续验证的是 0.23.1 这一依赖版本的差异。0.23.1 把共享 RwLock 缓存改为 TLS，但依赖中的 regex 等也随之变化，收益需分开归因：TLS 之外，依赖里的 regex 等也随之变化；上游 88+ 线程的成绩也难以直接套用。[E50]

E51 验证了三条路线。完整 12690 窗的 IDs、roles、masks 和 UTF-8 切点全部相同。[E51]

| 路线 | 当时结果 | 后续 |
| --- | --- | --- |
| 0.22.2→0.23.1，单线程 | 首遍 1956.345→1751.305ms，快 10.48%；复用快 14.22%。小 Native 的 181104 个 FP32 分量相同 | clear/drop/reload 后旧 TLS 约每代增加 4.05MB，需先解决线程生命周期 |
| 固定 0.22.2，四 worker，与 Native 分时执行 | 首遍 1997.301→1467.672ms，快 26.52%；CPU 约 +70.7%，RSS +7.49MiB | 原型预备长源的全部窗口；错误与 sink 的时序尚未对齐，需先对齐才能合并 |
| BPE 缓存容量 | 5000 比 10000 慢 11–14%；30000 仅快 0.93%/2.96%，两者均为 2/3 轮更快，缓冲多 8.59MB | 保留 10000。容量内的对照有效；旧回放中平铺的 3282 包并非原来的 3424 组 |

E52 最终采用组合方案：共享的不可变 BPE，query 也交给 worker（即 `lateon/tokenization.rs` 中四个模型生命周期 worker）。每个源只预备首窗；原文批超过 64KiB 时转为串行；token 错误按源延后上报，以保持原 Native/sink 的优先顺序。普通错误与取消可恢复；worker 丢失则 poison 并清理。drop 时关闭并 join，避免 BPE TLS 在长生命周期的 owner 上累积。[E52]

组合后分词首遍快 37.83%、复用快 35.87%；代价是 CPU +46.33%，探针 RSS +20.70MiB。正常 CLI 从 103.932s 到 100.228s，快 3.56%。12 代加载的残余增长定位在 ByteLevel 共享 regex scratch 上，17.242→17.259MB 后趋于饱和。这是有限输入下的观测，并非 heap/RSS 的硬上界；也未做 fork、trim 或 GC。

Gigatoken 仅完成调查，用户随即叫停，未编译测速。LateOn 的 NFC/ByteLevel 有适配基础，Bekko 的 WordPiece 目前无支持；added tokens、角色 marker、trim/mask 仍需等价验证。上游约 54× 用的是另一套数据规模、并行方式、缓存和包装，无法代表本机收益；nightly 依赖与默认 512MiB/worker 的预算，也无法直接套到现有的四个 worker 上。[E53]

### 3.2 首建 I/O 组织：growth、批 ACK、3+1 pipeline

E47 给出线索，E48 做隔离原型，E49 补正常 CLI。当时估算的 writer 份额和 CPU÷4 墙钟上限均已撤回，只保留实测结果。[E47]–[E49]

| 路线 | 结果 | 决策 |
| --- | --- | --- |
| BudgetFile 增长摊薄 | fallocate 194→27、policy open 196→16；独立稀疏文件审计发现两臂都有预算缺口，正式 ScopeIndexWriter 中未复现。E49 正常 CLI 候选比同源控制慢 4.209%，两轮都慢 | 暂未纳入。syscall 减少未必带来更快的结果；稀疏预算缺口单独记录 |
| 按 Native 批 ACK | 载荷与排序相同；正常 111.548→109.367s，平均快 1.955%。但只有 1/3 对更快，配对中位数慢 1.322%，排队还拉大了时点差 | 收益不稳定，未采用 |
| 3 Native + 1 handler pipeline | 同四线程预算下，125.654s 比正式版的 108.710s 慢 15.587%，两对都慢；对 serial3 的 3.238% 改善抵不过代价 | 未采用。保留四源 flush 与四窗的组织方式；这一结果只针对本次的 pipeline 设计 |

growth 在 1024MiB 档位发布后，两臂的审计都出现超额（baseline 552960B、候选 421888B），超额并非候选独有。
E49 的正常小 scope、预算回退、暖读和载荷检查均已通过，但该线未进入正式安全修复。[E48]、[E49]

### 3.3 首 QKV：从计数线索到完整 Native 与正常 CLI

E56 在原 3424 组上统计：3827918 个 token 位置中，批内 unique 只有 752588 个，首投影的行数可减少 80.34%，单批最大 U=693。这只是首 QKV 矩阵的行数减少，整模型收益需另行测量；也无需建 147.6MiB 的整表缓存或做跨文件去重。[E56]

E57 原型只计算批内的 U 行，保留原 embedding 供 residual 使用；mapped 首 RoPE 仍按原 T/segment 位置写出完整的 Q/K/V，RoPE 之后的状态保持重算。[E57]

- 715 窗/192 组三对完整消费分别快 5.190%/6.021%/2.739%，合并 4.629%。
- 小门中 1283328 个最终 FP32/F16 分量相同；全部 12690 窗的 141752688 个 FP16 分量、原 query FP32 和 12689 项分数逐位相同。未采集全库 FP32 gold；带校验的那次 89.605s 只作记录，未计入性能样本。
- 最坏情形 U=T=2048、错误、进入 mapped op 后的取消与恢复均已通过；arena 峰从 39.73MB 增至 46.26MB，总分配从 52.30MB 增至 82.71MB，仍在 128MiB 以内。

E58 正常 CLI 两对分别快 1.539%/2.504%，合并 95.852→93.918s（2.018%）；247076282B 的语义载荷、各 lane、分数和 stdout 完全相同，发布与暖命中路径也已通过。但只有两对，且 daemon HWM 增约 6.50MiB，因此暂未采用。它与 E52 的分词收益无法相加，据此也推不出普遍 2% 的收益。[E58]

### 3.4 GeGLU：组件变快，全模型未必稳定变快

这里的 producer 是：原 FMA3 微核直接产出 gate/up，再用原 Erf 生成 384 维。它省掉了 T×768 的中间张量和一次并行区，但 GEMM 与 Erf 的元素量未减少。
它与已采用的公开 ORT Erf（`01773c2`）、E20 的阶段重排、E43 的后处理单趟核，分属三种不同实现。

| 阶段 | 结果 | 含义 |
| --- | --- | --- |
| E57 单 FFN | 4096000 个 FP32 分量相同；Run 合计快 13.893%，但 M70 慢 5.157%/16.327% | 仅适用于组件层面，全模型结论需另行验证；Session PrePack 亦未宣称完成。[E57] |
| E58 七层 Native | 真实 Session PrePack、owner 与取消恢复通过，1283328 个最终 FP32/F16 相同；三对为 +0.310%/−16.831%/−8.808%，控制自身漂移 4.919→6.468s | 稳定收益尚未得到证实，未扩展到正常 CLI。[E58] |
| E59 按 gated384 改分轴 | M441 微核 592→456、M587 784→600；定向六轮合并慢 1.840%，192 组合并快 1.290%，但目标组没有改善 | 调用减少未必带来加速，该改轴未采用。[E59] |
| E60 算子与环境诊断 | GEMM 约占 63.4%、spin 约 9.1%、Erf 直接符号约 0.16% 的 CPU 样本；慢 worker 拖住 barrier | 瓶颈主要在 GEMM 与 barrier 等待，而非 Erf 或唤醒延迟。CPU 占比无法直接换算为可节省的墙钟时间。[E60] |
| E61 健康时钟重测 | 192 组六轮 Native 快 1.599%、消费快 1.792%，5/6 轮更快；A/A 约 ±1.6%，前后半的收益收窄；短面板消费慢 0.741% | 有微小的正向信号，但未正式采用；arena 峰确实低 2.91MiB。[E61] |

E60 的 175 层 trace 显示，各 lane 任务量相同，但慢的 lane 执行时长可达其它 lane 的 1.5–2 倍。guest 校准后 CPU 时间约等于自身 wall，但仍无法排除 host steal、频率、共享核和 cache 停顿。同一 ELF 的 A/A 在旧 focus 协议下也能偏离 5.73%，因此“每轮方向一致”只能说明一致，无法证明协议无偏。32 组 20 轮相邻 A/B 的轮均值低约 2.6%，另一时窗的 A/A 低约 0.9%；两个数字无法相减得到净收益。同窗口三 Session 驻留未见系统性惩罚，但该结论只适用于本次负载。[E60]

E61 的消费轮均为 −1.776%，标准差 1.493 个百分点；前 3 轮 −2.842%，后 3 轮 −0.711%；A/A 消费范围为 −1.577%～+1.637%。query、F16、MaxSim 和短面板的最终 FP32 相同，持久 InUse 与总分配保持稳定，分配次数减少 1351 次。健康时钟下 A/A 仍有波动，因此时钟故障只能解释部分慢点。[E61]

### 3.5 local：banded 仍会改变数值，exact 保值但未提速

原 banded 按 32-query 块划分，段内 ±64，最多 129 个有效 key，union 最多 160；MLAS packing、softmax 和 PV 后的除法都照常计入 Native。union 使内部位置对增加约 24%；范围并未任意扩大，上下文也没有减少。[E57]

banded 的性能与质量：

- E57 的 21 组 Native 三对分别快 13.849%/4.779%/2.981%（首对控制有漂移）。CoSQA500 与全部 6267 个候选的金标名次、Hit1/5/10 和 MRR 相同；369 题的金标 score 末位变化，1 题的 non-gold 第 6/7 名交换，Top10 成员保持不变。[E57]
- E58 补测了 RepoQA600，覆盖 60 个 scope、8775 个文件。两臂各完成 587 题，相同的 13 题因长度被拒，分母仍用 600。逐题 goldrank、原 Hit/MRR/覆盖一致；48 题的 Top50 顺序有变化（其中 4 题成员有变），564 题的 gold chunk 分数有变化。评估器沿用原版，并非官方 SNF；排序也并非处处与原版一致。[E58]
- 正常 EverTrace 两对分别快 6.450%/13.618%，合并 10.151%，第二对控制的漂移明显；最终 5 条内容身份相同，但分数全部变化，因此无法承诺稳定的 10%。[E58]
- 新算术 `ort-1.31-erf-local-sgemm-v1` 已在私有 producer、manifest、catalog、Native、Rust 和 artifact 键中贯通。C→P→C 各自重建，各自在下一次命中，跨 manifest 时被拒绝。正式接入时必须保留这套隔离，原算术的缓存只能各自使用。[E58]

exact 如何恢复原值：

E60 把 QK 与 PV 拆开：保留原 QK，PV 固定使用非 FMA AVX，并禁用 M1 快路径。38 个 Native/边界场景、全部 EverTrace 的 141752688 个 FP16 分量、原 query 和 12689 项 MaxSim 都恢复为原值。原先 4 个 RepoQA 成员变化的题，用完整 scope 和新的空缓存重建后，Top50 条目、顺序和全部分数都回到原状；这一步并未重跑全部 600 题。主动取消、恢复、arena、idle 与线程回收均已通过。旧的小面板先快 3.626%，但独立的双时钟复核显示慢 1.363%，当时未采用。[E60]

E62 健康时钟重测：两个候选和 A/A 按六种顺序平衡排列，192 组真实样本加上原来的 17 个边界场景各跑六轮，参数未重新调整。

| 条件 | 192 组 Native | 192 组消费活动段 | 边界消费活动段 |
| --- | ---: | ---: | ---: |
| banded | −2.149% | −2.133%，6/6 快 | −1.156%，方向摇摆 |
| exact | +0.316% | +0.329%，2/6 快 | +1.805% |
| A/A | −0.355% | −0.367% | −1.485% |

banded 的消费轮均 −2.144%，标准差 0.796 个百分点，前后半分别为 −1.964%/−2.325%；A/A 单轮范围为 −2.061%～+1.518%，仅作波动参考，直接相减会误作净收益。
exact 与原 query、F16、MaxSim 逐位相同；banded 仍会改变 645/720 个 query FP32 分量、22036/7826736 个文档 FP16 分量，以及 8200 个 MaxSim 矩阵元素。这些是分量计数，与文件数、排名数或质量回退百分比口径不同。各边界场景按 E60 冻结的算术分别比对：exact 为零差异，banded 的值仍会变化，旧的排序风险依然存在。各臂的 arena 相同；MLAS 桥和约 70KiB/lane 的 packing 栈仍是外部成本。[E62]

处置：exact 未采用；banded 作为约 2% 的小幅候选保留。健康时钟下的正常 CLI 资格尚待补齐，暂未正式纳入。

### 3.6 ZG 借鉴：尾批平铺与共享上下文

E54 从 zvec-grep 的 fragment 攒批、SessionPool 和 PrepackedWeights 中获得线索。它的 CPU 并发规模与本机四线程不同，收益无法直接套用。#319 的多 collection ANN、#329 的资源放置、#315 的身份保护删除，在当前合同下都不可用。[E54]

尾批平铺：原四源 flush 为 3424 组，同序后为 3282 组，调用数少 4.15%，但提速幅度需另行测量。E55 的全部 141752688 个 FP16 分量与 query/MaxSim 相同；两对 Native 分别为 +1.548%/−3.387%，合并只快 0.968%，仅 1/2 对更快。这点收益不足以支撑为此重做 stream、record、错误处理和公平性的 owner。[E55]

共享静态模型加隔离的 run contexts：在相同的四计算线程下，1×4 与 2×2 双上下文对比，双上下文都慢，平均慢 +11.250%；RSS 约从 202MiB 升到 254MiB，持久 arena 约从 15.60MB 升到 31.20MB。128MiB 上限、取消隔离、恢复和 idle 都通过，但容器共享未必使所有 initializer 和 packed 权重只驻留一份。修复空闲 spin 之后仍然偏慢。这只说明这一版实现偏慢，所有共享上下文是否有效仍待验证。[E55]

两个原型都已停止，暂不恢复；正常产品 CLI 与理想的 fully-shared 实现均未取得资格。

### 3.7 E63 调研时的候选：后续实现与判别见 3.8

- R4 让四个 query 行共享 K，区别于旧版的四 key 共享 Q、Q 常驻 V1 以及跨 head dot4。设计目标是保留原来的逐 dot 归约顺序，但当时尚无内核、逐位一致性或速度方面的验证。
- 原 Native 实际调用中，主干 N768/K256 的 BIsPacked=1，输出 N48/K256 为 0。这说明准备工作的缺口落在不同 owner 手里，但仍无法证明它能带来提速。旧版 Output 份额很小，因此未将其列为首建主线。
- LIBXSMM 支持 FP32/AVX2，但要真正获益，需要有界的小核、原有归约，并把 JIT 与 packing 的净成本算进来。shape 加限定的 ResidualNorm 复用一直未实现，因此仅做 annotation-only 的重做没有意义。
- half 2.7.1 已使用 F16C，Native 输出直接绑定到 caller 缓冲；批量转换尚未测。词法重复有源码线索，但近似的微探针无法给 CLI 设定上界。
- 旧采样中的 0.78s writer CPU、无邻近 pool 样本的分类，以及理论峰值，均无法证明它是硬墙钟上界、硬串行，或“已经没有优化空间”。统计脚本的 FFN-up 形状已修正，结构 FLOPs 不再作为性能权重。[E63]

### 3.8 E64：五条候选均已实现到有限门，结论为停用

两个新会话（Sol/xhigh）独立验证，收益未作组合。下表是本轮面板的耗时变化，负数表示变快，属于面板内耗时，未作为新的 CLI 首建成绩。[E64]

| 方向 | 结果与处置 |
| --- | --- |
| R4 跨 query 共享 K | local 11808000 个 F32，以及有限的 Native F32/F16/MaxSim 完全一致；192 组四对消费合并 −0.133%，只有 1/4 更快，AA +0.317%。组件层面快 14–19%，该数字只适用于组件。未采用 |
| LIBXSMM FP32/AVX2 | M8/16/17 每 lane、N48/K256，7872 个原投影 F32 与实际 MLAS/顺序 FMA 一致；首用总耗时 +16.430%，热 compute −19.624%。首用小门未见净收益，暂缓迁移；大 M、长摊销和最终表示当时均未测 |
| 完整 shape 加 RN 可选复用 | 初版 78/169 与最终 169/169 分开记录；最终 33 个 NodeArg 契约、两个输出彼此独立、有限原值相同。alloc 1372→800，但 arena 峰 +11.01MiB，四对 +2.009%，3/4 对更慢。未采用 |
| 末投影 prepack | 49152B owner，BIsPacked=1；M43/1729 原投影 F32 相同。长 M 时 3/4 对更慢，AA 波动大；未接入 Native 桥，也未测最终 L2 表示与 MaxSim。未采用 |
| 批量 F16C | 标量路径本来就是硬件转换；253960 个边界输入与真实 FP16 同 window-MaxSim 相同。组件约 13ms 对 18–22ms；12 组 Native 消费 +3.016%，2/4 对更快。完整收益未证实，未采用 |

四对、慢样本和 AA 均完整保留，未扣减 AA 均值来追正。数值资格只覆盖各检查门，未做全部 12690 窗、多轮 CLI 或 1100 题测试。
LIBXSMM 首次 make 在解析阶段创建、删除过私有 .ln 软链；已报告并修正了后续路径。该 archive 只作为带违例标记的探索工件保留，缺少干净构建的资格。最终版本已无链接，这段历史仍需保留。[E64]

### 3.9 E65：LIBXSMM 输出投影进入当前 EverTrace 完整首建

E64 的首用小门只能说明首用成本，长期摊销仍需单独验证。这一轮把 N48/K256 接入 Native：M16 分块加精确的尾长处理。原四 lane、128MiB、上下文、归一化、FP16 与 MaxSim 均保持原样，count1 仍走 MLAS 特化。这一版只替换输出投影，主干的全后端替换仍未测。[E65]

- 使用当前 385 文件快照（含用户未提交内容，取自当前工作区，区别于旧 scope）；每点 13011 个片段、13012 个窗、3922787 tokens、3030112 行、3507 批；fresh 服务、空索引、1024MiB 预算。
- 固定顺序 C1/P1/P2/C2：112.142665/126.260666/114.392248/110.000568s；两对分别为 +12.589%/+3.992%，均值 +8.332%。只有两对，且候选波动较大，既无法认定为固定回退，亦未追加轮次。
- JIT 的 16 个有界形状只初始化一次；投影 3508 次，tile 191024 次，code 27408B。首 query 与模型初始化只差 40.886ms，文档阶段差 9.058807s。这 9.25 秒的来源尚无法归于 JIT 或小核本身。
- 前置的 28 个 case（F32/F16/MaxSim/取消恢复）已通过；四次完整的 253517525B 语义载荷，以及记录的各排名通道和 stdout 完全相同。全库未额外采集 FP32 gold，因此未形成 1100 题结果。
- daemon 累计 CPU +8.605%，VmHWM 各增约 2.00MiB；128MiB 上限保持，full arena 峰未测。两臂代码直接用 g++ 编译；旧 archive 的历史链接违例标记保留，缺少干净的发布资格。
- 整库接入未采用。大 N/K 主干、其它 tiling、其它仓库以及物理冷页都未测；这一版结果只说明输出投影这一处，无法代表整个 LIBXSMM。[E65]

### 3.10 E66：纠正 E65 的归因，定位大 M 拆碎的真实代价

验证顺序：先在同一 Runtime、同一输入上跑 192 组 CP/PC/CC/PP；再用 48 组 loaded-only 对比 48 组相同的控制副本；最后在当前 385 scope 的同一输入上做双投影与组织三臂对拍。这一步未再跑一轮整库。[E66]

- 当前全 scope 共 3508 次末投影：172.839805→189.304846ms（+16.465041ms/+9.526%），只占 102.155s Session.Run 的 0.169%/0.185%。145446096 个原始投影 F32 完全一致，完整载荷、各 lane 和 stdout 相同。
- 主干只执行一次。额外执行的另一投影交错安排 CP/PC，并保留原结果；诊断 wall 为 111.638s，未并入 E65 的正常均值。CP 与 PC 各 1754 对，局部都没有变快；这 16ms 的额外开销无法直接套用到旧的 9.25s 上。
- 组织对拍使用 actual MLAS、真实输入和四 lane：每 lane 16 行时，XSMM 比原 MLAS 快约 17.44%；总 M=1515 时，整段 MLAS 4.274ms → tile16 MLAS 6.214ms → tile16 XSMM 4.969ms，大 M 三轮都变慢。原 packing 可以跨 M 复用，拆成小调用后摊销随之丢失。packing、调用和访存各占多少，尚未拆开测。
- loaded-only 的 Run 为 −0.0197%，相同控制副本为 +3.5279%；同 Runtime 的 CC/PP 第二次为 −1.95%/−3.29%。E65 整轮的 +8.332% 未能隔离出进程或执行状态的差异，因此只能说它尚未归因于库的固定开销；也没有证据表明那 9 秒全是系统噪声。
- tick 全为 10000，主线程 MXCSR 相同；WSL 的 cycles 事件不受支持，旧现场也没有宿主或节点层面的证据。频率、迁移、cache 等物理来源仍未确认。
- 末投影只占约 0.17%，局部没有净收益，未采用。大 N/K 主干仍未测，本轮结果无法否定它。E65 的观测与失败均已保留；源码只放在 `.work` 中，Bitter Lessons 只补充通用的摊销与归因经验。[E66]

### 3.11 E67：每 lane 整段 JIT，对比 16 行碎调用

N48/K256、精度与四 lane 保持原样；每个 lane 一次处理自己的连续行段，lazy shape cache 有界（最大 512）。
先在组件里确认 378/379/512 行的 hsw JIT 真实生成且为非 reference 实现，共 6 个形状、code 12584B；所有形状的三臂 F32/F16 结果均为零差异。[E67]

- 用真实 normalized A/B 与 actual MLAS 对拍：原每 lane 整段、旧 tile16 XSMM、新整段 XSMM；每 lane 64 次，三种顺序固定轮转。初始化与首次调用单列，判定时只看重复计算，首次调用的亚毫秒成本另列。
- 1515 真实行：MLAS 4.862132ms / 旧 5.402638ms / 新 5.090322ms。新比旧快 5.781%，但比原 MLAS 慢 4.693%，三轮一快两慢。2048 是把真实行循环补足得到的合成几何边界，新比原慢 20.651%，方向同样摇摆。
- 总 64 行时每 lane 正好 16，新旧粒度相同，短相位有明显慢点；表面的 42.66% 差距无法兑现为模型收益。扩大单次 JIT 的 M 追回了一部分外层损失，但未达到 MLAS 完整的缓存分层效率；成本未独立拆分，也无法全部归因于 packing。
- 组件使用自建的 3 worker + caller，并非原 ORT 池；尚未进入 Native、新 EverTrace 或 1100 题测试，全 512 缓存的内存峰也未测。收益不稳定，按用户决定停用，路线到此结束；停止尝试其他块大小；未测方向须另行立项才能执行。[E67]

## 4. 其它已验证的方向与结论

### 4.1 Attention、布局与裁行

| 方向 | 结果与未采用原因 |
| --- | --- |
| 仅补 97 个中间 shape | synthetic 输出相同，单窗 alloc 83→29，但峰值 36.57→53.35MB，时序混合，出图时还触发缺 Gemm。annotation-only 未采用；后续完整 shape 加 MayInplace 已测，峰值增加且无净收益。[E37]、[E64] |
| local 整行 AVX2 域加 Q 常驻 V1 | Native/gold 与分支检查通过；完整面板中 2/4 更快，合计慢 0.324%。它与旧 QK4 的原样重试是两回事。[E38] |
| global Flash Br128→64 | KV 不变，Br64/Bc1536 及尾块命中，gold 相同；四对均慢，合计 +4.754%，长 1810 慢 2.816%。scratch 减半未转化为 arena 或 RSS 收益。[E38] |
| global Flash Bc768/512 | 相对原样重编慢 4.570%/1.573%，FP16 变化 604/4169 个分量；重编的 control 本身比正式版快 4.076%，这部分差额应归入重编本身，而非 Bc 收益。[E43] |
| global RoPE 直接写 BNSH（N2） | helper 9/36→0，值相同；真实旧 control 四对中只有 1 对更快，合计慢 5.730%，内存略高。与 A2 版本不同，两者须分开比较。[E35]、[E36] |
| Global Flash 直接 BSNH stride（A2） | helper 9→0，所测 FP32 相同；文档四对从快 4.30% 变为慢 4.12%，合计仅快 0.352%。它共用支持 stride 的 MLAS，尚未取得对纯旧正式库的最终资格。[E33]、[E34] |
| no-bias 转置交原 pool（A1） | 长 1810 实际分为 16 片、4 线程，FP32 相同；文档四对合计慢 1.127%，短 query 与四窗场景退化。这只说明该方案在当前场景下失效，未必代表所有并行方案失效。[E34] |
| local K/V head-major 先复制 | 内核快约 1.18–1.25×，但约 0.302ms 的转换耗时吃掉了收益；节点 4.099→4.106ms，scratch 增约 2.44MiB。[E42] |
| local RoPE 直产 head-major | 没有中间复制；1790400 个最终 FP32 与 FP16 相同；四轮 2 快 2 慢，合计慢 1.800%，arena 峰增 5.02MiB。consumer 的改善只能算局部收益，无法代表整图收益。[E43] |
| local RoPE/attention 融合 | 删除了四层的 Q/V 中间值，最终 FP32 相同；standard 合计慢 1.609%，ragged 慢 5.396%，分配与长峰都未下降。V stride 与延寿的影响未隔离，原因未定。[E40] |
| 末层选 Q、完整 K/V | E40 未通过零 FP32 门；E41 在全部 12690 窗中各有 1925 个 FP32 末位差，最大 5.96e−8，但 FP16 全部相同。正式 Native 两对一快一慢，合计慢 0.083%，没有稳定收益。[E39]–[E41] |
| 最后层 attention 后裁行 | 七层 QKV/attention 仍全算，只裁掉 Wo/FFN 尾部，首建无稳定收益。它与选 Q 及完整 K/V 的验证是两回事；更早层的上下文仍需保留。[E16]、[E39] |
| local QK4 | 窄完整 Native 面板上无稳定收益；它与 MaxSim Q4 或线性 QKV 微批是两回事。[E17]、[E20] |
| local PV2/PV4 跨 query 共享 V | 129 个张量相同；四对中位数慢约 8.93%/3.40%。它与已采用的沿值维 SIMD 二者互相独立。[E22] |
| RoPE AVX2、通用连续调度 | 多轮完整面板与首建都没有稳定收益；保留原池和预算。[E16] |
| 旧 local softmax 向量 exp | 改变了浮点结果，只是组件层面的候选，未取得完整质量资格；与后续的位同 exp 是两回事。[E26] |
| glibc2.39 FMA 位同 SIMD exp | 区间 [-87,0] 的 1118699521 个有限 float 零差异，组件约快 3.45×；真实 Native 从 914.517ms 变为 911.485ms，long 慢 1.87%。LGPL 及其它 libm、其它平台都未取得资格。[E42] |

### 4.2 Dense、FFN 与线程调度

| 方向 | 结果与未采用原因 |
| --- | --- |
| packed SGEMM N64/N256（N1） | 真实 packed/FMA3，四份完整 FP32 与 gold 相同；N64 完整两对一快 6.970%、一慢 5.882%，合计快 0.771%，但波动大；N256 首轮无收益。保留 N128。[E35]、[E36] |
| Residual/LN 八行 AVX2 | 完整面板中位数快 0.53%，但只有 2/4 对更快；叠在已采用的四行 SSE 之上收益有限。[E20] |
| GeGLU scale/Erf/gate 阶段融合 | 完整面板慢 0.64%，2/4 对更快。公开 ORT Erf 已采用，但额外融合未必同样有效。[E20] |
| AVX2 GeGLU 真正单趟 | 原 MLAS 与原池下，组件 1.11–1.62×，最终所测 FP32/F16 相同；standard 慢 4.860%，只有 1/4 轮更快。它与 E20 的重排或后来的 GEMM producer 是两种实现。[E43] |
| FFN 行 tile256 | 原 PrePack 14 次、原池，所测值相同；对同镜像原图慢 12.466%，对 full-wrapper 慢 6.333%；arena 峰低 1.787MiB，但 RSS 更高。桥接与 initializer 生命周期未完全等价，因此对正式版的全部差额无法都归因于 tile。[E43] |
| oneDNN strict FP32 | 3.1.1 版全部更慢，M15 有微小差异；3.11 版 AVX2 的八种形状位同，但慢约 3.9–76.2%。本轮停止桥接；结论仅针对这些版本，无法推广到所有 oneDNN 或 CPU。[E22] |
| MLAS 8/16 任务，仍用四 worker | 分支与值都正确；8 任务慢约 0.63%，16 任务仅快 0.24%，2/4 对更快，没有稳定的文档收益。[E22] |
| M≤32 线性层由 caller 直接执行 | 短 query 省下 0.1–0.4ms 的 spin，但叠加 Run-spin 后约多 1.3ms，比单独 spin 的 0.64ms 还慢，组合方案未采用。[E22]、[E23] |
| 模型全生命周期允许 spin | 短寿命诊断快约 11.5%，但没有常驻 idle 的资格；由已采用的 Env/Run 级启停替代。[E22]、[E23] |
| T3 通用小行数 rowwise 直跑 | 同一构建下只在少数窄场景显示信号，整体波动大；阈值与挑选结果脱钩。LN 专用快路另有资格。[E13]、[E14] |

### 4.3 微批、精度与低收益 I/O

| 方向 | 结果与未采用原因 |
| --- | --- |
| 两窗线性微批 | 最终组件净慢 0.32%，只有 2/4 对更快；四窗是另一套经过完整模型和 CLI 验证的实现。[E18] |
| 合并 QKV 后复制拆回各窗 | 两窗慢 32.25%，四窗慢 18.80%；复制抵消了收益，后来改用共享视图，才有了四窗方案。[E18] |
| 八窗、ABI4、更大 source 组 | Native 一对快约 4.48%；真实首建 148.532/109.183s，对同库四源的 113.302s 结果波动大。长源之后短 H 约 4.9s；轮转原型虽降到 64–72ms，仍未补齐首建收益。[E20]、[E21] |
| CPU row-scale W8A8 的 28 个 dense | 含量化还原的 128 窗快 33.98%/35.30%；但 CoSQA500 Hit1 从 257 降到 251，MRR .656560→.649842，102 题排名变化，未通过质量门。[E43] |
| W8A8 固定 500 题各 10 次复测 | 各模型的载荷、每题排名、Top10 和 score 十次全部相同，质量方差为 0，退化可重复。Native 文档均值 14.079903→8.734316s，方差 .453267/.149154s²；准备后每题 39.851/39.936ms。这并非新的 5000 题或正常 CLI 测试。[E44] |
| INT16 容器 / signed12 替换 28 个 dense | guest 未暴露新的 AVX-VNNI-INT16，基础 VEX VPDPWSSD 实际命中；±2047、K≤512 的安全界已验证。500 题 Hit1/5/10 相同，MRR .6565603175→.6562103175，4 题退位；没有接受这一代价的授权。[E45] |
| signed12 正常首建补测 | 固定三对 shared CLI：FP32 均 112.498s，Q12 均 110.937s，只快 1.387%，1/3 对更快。条件同为 12690 窗、空索引，没有稳定的采用依据；这一结果只适用于 signed12，与其它 INT16 方案无关。[E46] |
| FP16 表启动时整表扩为 FP32 | 所测的 gather/expand 输出相同，但启动耗时和常驻内存更差；保留按行取值再扩展的方式。[E25] |
| FP16 权重 sidecar 再扩为 FP32 | 恢复和 prepack 仍有开销；小中范围无稳定收益，当前 backbone 仍是 FP32。[E25] |
| 直接用 libmvec 向量化 Erf | 组件更快，但 FP16 值改变，且引入 GLIBC_2.35 依赖，未取得完整交付资格；后来采用的是公开的 ORT Erf。[E26]、[E11] |
| 首建时整窗或原文严格去重 | 原文只有 281/7869 个 tokens 重复，完整的 role+IDs/mask 只有 307/8426 个；旧轮理想 Native 节省约 0.746s/0.6%。本方案无需新建 cache，首 QKV 的局部行复用不受影响。[E17]、[E56] |
| 单核 MaxSim query-hoist/direct-dot | 全 scope 分数相同，但重 scope 下略慢，原实现保留；它与已采用的 Q4 融合是两回事。[E27] |
| record 定长 header 合并写 | write16→5，但两个范围分别为 424.72→434.90ms、873.19→884.81ms，都是变慢；未采用。[E24] |
| builder 压缩器复用 | codec 6.806→6.625ms，整次收益小于波动；与已采用的 decoder/DCtx 复用是两件事。[E24] |
| Rust FP16 owned handoff | 真实 CLI 上未显示收益，未采用。这与 FP16 存表本身无关。[E24] |
| 小 JSON 缓冲的独立冷启动优化 | 冷启动中位数无收益，text 原型慢约 8.4ms；整体的 ready/启动方案另有采用记录。[E07] |
| lossy 展示路径判断 record 复用 | 非 UTF-8 文件名可能折成同一展示串，原型让改名后的对象被误复用；分数相同时没有暴露资格错误。正式实现要求 raw 身份与唯一映射。[E14] |

## 5. 未测、暂停与剩余事项

以下条目均非默认执行计划。重启已否定的路线，需要在实现、硬件或 ISA、布局、库或等待策略上有实质的新假设。

| 方向 | 目前边界 |
| --- | --- |
| 其它 FFN 组织 | tile256 已测为负；其它尚未实现的组合应单独判定，应与 tile256 分开判定。shape 加限定 RN 复用已在 E64 实测，已从待测中移出；每种组织仍需各自的数值、生命周期和净收益资格。[E42]、[E43]、[E64] |
| 有限 MemoryPattern、ragged 任务合并 | 自建的有界模式缓存、删除四段 Invoke 的方案都未取得资格，且只能在外层线程之外使用；直接开启 ORT MemPattern 时输出相同，但 arena 约 39.6→68.8MB，重复面板 909→949ms。FTZ 没有稳定收益；Br256 使 39 个 FP16 分量发生变化，长窗的 query block 约慢 17%。[E33]、[E35]、[E56] |
| local 跨 head dot4 | micro 位同，QK 最快约 1.05×，尚无完整的 local/Native 收益资格；与旧的四 key QK4 不同，暂列为研究候选。[E56] |
| THP 提示、固定 CPU affinity | E56 两侧的 AnonHugePages 都为 0，巨页实际未生效；但这只说明本次未生效，据此尚无法断定 THP 本身失败。WSL 的 CPU 编号没有映射到物理 P/E 核，因此无法据此固定产品核号。[E56] |
| CPU FlashGEMM、其它后端、PGO/LLVM | 作者实现需要 AVX512，且当前无法激活，并非直接适用于 265K，许可也未明确。旧的人工峰值参照因 spill、segfault 和负载问题已作废；PGO 仅是机制线索。LIBXSMM 的输出投影已在 E65 完成首建测试，大 N/K 主干和其它后端组织尚未测。[E37]、[E42]、[E56]、[E65] |
| 首 QKV 整表或长期热行 cache | 批内复用的无 cache 版本已进入完整 Native/CLI 测试，已从未实现中移出；整表约 147.6MiB，或 model-owned 3MiB 热行，仍未取得资格。计数模拟与实际命中率或速度并不等同。[E22]、[E56]–[E58] |
| 全 FP16/BF16、Bekko FP8 | 只完成了硬件与格式调研；用户已停止全低精度路线。当前 LateOn 为 FP16 表加 FP32 前向，Bekko 已是 INT8 单字节权重，FP8 无法再减半，且 265K 没有原生 FP8 加速。未做公平的全引擎比较，因此只能说尚未测试，无法据此判定更慢。[E28]、[E30] |
| W8A8 质量恢复 | ModernBERT 补偿、非评测校准、敏感层混精度均未验证；用户已停止继续。退化结果须经用户明确接受；重跑追正的做法须避免。[E42]–[E44] |
| 新 GEMM 后端与原 pool 的集成 | 旧 oneDNN 组件已测为负；只有版本、布局或硬件发生实质变化，才值得新的桥接，原样重试没有意义。[E22] |
| 秒级尾部、writer/配额锁混合等待 | 历史上 850ms/17s 的等待原因尚未完全定位，长 M 期间 H 仍可能出现秒级等待；Run-spin 未改动队列或长写锁。fsync、source 和配额保护须保留；消除等待的改动需另行论证。[E05]、[E23]、[E27] |
| 新候选的跨平台、三路压力与 P95 | 旧阶段各自的并发与 cgroup 资格无法自动覆盖每一个新 Native。小面板、正常首建、物理冷页和全进程组硬 RAM 需要分别验收。[E06]、[E23] |

下列做法违反现有合同，禁止用作提速手段：缩小候选集、用 ANN 替代全库、截断 query、跨文档共享 attention、跳过 source/CRC/恢复检查，或增加线程、模型副本、arena。此为合同约束，而非实测结论。

## 6. 历史纠偏与后续记录

- 旧“待测”要随结果更新。首 QKV、带状 SGEMM、选 Q/完整 K/V、FFN tile256 后来都已实测；完整四窗和 Run-spin 已采用。旧报告保留当时口径，本表记录最新处置；“未采用”与“未实现”是两回事。
- 先确认实现身份，再谈性能。旧 T1 两臂用的是同一个文件，那次否定无效；经独立的目标验证后采用了 `9431515`，此后以新结论为准，旧结论不再重跑。[E13]、[E14]
- 验证要选对层级。normal-v2 曾因整文件 SHA 不同而误判，`dce5f15` 保留了纠错记录；确认 record 与 FP16 载荷相同、复用 2061 次观测之后才接受结果，也未为通过而重跑。[E29]
- 采样不等于资源资格。`3ad0784` 只做了采样，单位与零占位后来做了更正；cgroup 证据在 `d89eefd`、`03126c0`。旧 memory.peak 为生命周期上界，而非各 case 的独立峰值。[E29]
- 精简时要保住源保护和数值合同。旧格式与宽几何回退并非死代码；重复工作融合之后，最终的 source、CRC、零分和错误恢复依然保留。
- 比较要包含整条成本。packing、复制、调度、内存都计入对应阶段；组件提速仅限组件，无法外推到 CLI；跨库、跨数据、跨时基的数值相加无意义；A/A 均值只作参考，无法用于扣减。
- 数值一致尚未构成全质量认证。四窗与 Run-spin 相对既有基线位级相同，但已接受的 FP16/Erf 误差依然有效；gold 指标相同，排序是否全部一致另需核对。sgrep 与 semantic 的模型、单多向量和目标各不相同，后来的小面板无法倒推出“已全面超过原版”。[E31]
- 失败与未测如实归类。setup、checker 和预热混合轮仅用于流程验证，与算法结果分列；旧失败与慢点保留在原报告中。净收益波动时即停止，避免靠追加轮次去“追正”。

## 证据索引

共68份证据报告保留在仓库根目录的 `.work/`，以下链接已按本文位置调整。源提交/会话核对见[E29]；逐次命令、模型/编译器、失败和资源边界以原报告为准。
另见[T1纠正清单](../../../.work/semantic-speed-exploration-20261031/OPTIMIZATION_CHECKLIST.md)、
[FP16 gather采用验收](../../../.work/sgrep-cache-query-improvement/fp16-gather-adoption/REPORT.md)、
[Native逐次HISTORY](../../../.work/semantic-native-research-20261106/HISTORY.md)。

[E01]: ../../../.work/sgrep-cache-query-improvement/REPORT.md
[E02]: ../../../.work/sgrep-cache-query-improvement/p0/REPORT.md
[E03]: ../../../.work/sgrep-cache-query-improvement/io-followup/REPORT.md
[E04]: ../../../.work/sgrep-cache-query-improvement/record-parallel/REPORT.md
[E05]: ../../../.work/sgrep-cache-query-improvement/shared-service/REPORT.md
[E06]: ../../../.work/sgrep-cache-query-improvement/warm-path/REPORT.md
[E07]: ../../../.work/sgrep-cache-query-improvement/cold-start/REPORT.md
[E08]: ../../../.work/sgrep-cache-query-improvement/first-build-pv/REPORT.md
[E09]: ../../../.work/sgrep-cache-query-improvement/fp16-storage/quality-full/REPORT.md
[E10]: ../../../.work/semantic-redundancy-implementation/REPORT.md
[E11]: ../../../.work/semantic-operator-implementation/REPORT.md
[E12]: ../../../.work/semantic-deterministic-implementation-20261031/REPORT.md
[E13]: ../../../.work/semantic-t1-t4-20261031/REPORT.md
[E14]: ../../../.work/semantic-adoption-20261101/REPORT.md
[E15]: ../../../.work/semantic-edit-rebuild-20261106/RESULT.md
[E16]: ../../../.work/semantic-cold-build-exploration-20261106/REPORT.md
[E17]: ../../../.work/semantic-evertrace-cold-build-exploration-20261106/REPORT.md
[E18]: ../../../.work/semantic-native-forward-20261106/REPORT.md
[E19]: ../../../.work/semantic-native-forward-20261106/adoption/RESULT.md
[E20]: ../../../.work/semantic-native-forward-20261106/followup/REPORT.md
[E21]: ../../../.work/semantic-native-forward-20261106/eight-adoption/RESULT.md
[E22]: ../../../.work/semantic-native-research-20261106/RESULT.md
[E23]: ../../../.work/semantic-native-research-20261106/adoption/RESULT.md
[E24]: ../../../.work/sgrep-cache-query-improvement/first-build-validation/REPORT.md
[E25]: ../../../.work/sgrep-cache-query-improvement/fp16-storage/REPORT.md
[E26]: ../../../.work/semantic-operator-fusion-audit/REPORT.md
[E27]: ../../../.work/sgrep-cache-query-improvement/astra-p95-audit/REPORT.md
[E28]: ../../../.work/sgrep-cache-query-improvement/265k-bf16-research/REPORT.md
[E29]: ../../../.work/semantic-history-audit-20261107/REPORT.md
[E30]: ../../../.work/semantic-history-audit-20261107/decision-excerpts.md
[E31]: ../../../.work/sgrep-retrieval-benchmark/REPORT.md
[E32]: ../../../.work/sgrep-v4-dev/reports/FINAL_DELIVERY.md
[E33]: ../../../.work/semantic-native-forward-research-20261107/REPORT.md
[E34]: ../../../.work/semantic-native-route-validation-20261107/REPORT.md
[E35]: ../../../.work/semantic-native-next-research-20261107/REPORT.md
[E36]: ../../../.work/semantic-native-next-validation-20261107/REPORT.md
[E37]: ../../../.work/semantic-native-kernel-research-20261107/REPORT.md
[E38]: ../../../.work/semantic-native-v1-querytile-validation-20261107/REPORT.md
[E39]: ../../../.work/lateon-modernbert-research-20261107/REPORT.md
[E40]: ../../../.work/lateon-modernbert-validation-20261107/REPORT.md
[E41]: ../../../.work/lateon-selected-query-followup-20261107/REPORT.md
[E42]: ../../../.work/semantic-native-architecture-research-20261107/REPORT.md
[E43]: ../../../.work/semantic-native-pending-validation-20261107/REPORT.md
[E44]: ../../../.work/semantic-w8a8-repeatability-20261107/REPORT.md
[E45]: ../../../.work/semantic-first-cold-build-research-20261107/sol-int16/PARENT_REVIEW.md
[E46]: ../../../.work/semantic-int16-first-build-20261107/REPORT.md
[E47]: ../../../.work/semantic-first-cold-build-research-20261107/REPORT.md
[E48]: ../../../.work/semantic-cold-flow-validation-20261107/REPORT.md
[E49]: ../../../.work/semantic-growth-adoption-20261107/REPORT.md
[E50]: ../../../.work/zvec-grep-tokenization-audit-20261107/REPORT.md
[E51]: ../../../.work/semantic-tokenizer-validation-20261108/REPORT.md
[E52]: ../../../.work/semantic-tokenizer-integration-20261108/REPORT.md
[E53]: ../../../.work/gigatoken-tokenization-audit-20261108/REPORT.md
[E54]: ../../../.work/zvec-first-build-audit-20261108/REPORT.md
[E55]: ../../../.work/zvec-first-build-validation-20261108/REPORT.md
[E56]: ../../../.work/semantic-first-cold-research-20261108/REPORT.md
[E57]: ../../../.work/semantic-e56-route-validation-20261108/REPORT.md
[E58]: ../../../.work/semantic-e57-followup-validation-20261108/REPORT.md
[E59]: ../../../.work/semantic-geglu-stability-20261108/REPORT.md
[E60]: ../../../.work/semantic-local-geglu-research-20261108/REPORT.md
[E61]: ../../../.work/semantic-geglu-clock-fixed-20261108/REPORT.md
[E62]: ../../../.work/semantic-local-clock-fixed-20261108/REPORT.md
[E63]: ../../../.work/semantic-first-cold-next-20261108/REPORT.md
[E64]: ../../../.work/semantic-e63-sol-validation-20261108/REPORT.md
[E65]: ../../../.work/semantic-libxsmm-evertrace-20261108/REPORT.md
[E66]: ../../../.work/semantic-libxsmm-cause-20261108/REPORT.md
[E67]: ../../../.work/semantic-libxsmm-large-block-20261108/REPORT.md
[E68]: ../../../.work/semantic-bekko-adoption/REPORT.md
