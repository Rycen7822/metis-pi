# Semantic retrieval benchmark

开发用的统一检索基准：RepoQA600、CoSQA500，以及用户提供的 EverTrace 工作树。
代码随 Git 分发；语料、模型、结果保存在 `.work/` 或 `external/`。
根目录的 npm `files` 白名单排除整个 `benchmarks/`，Pi 安装和更新均不会运行这些工具。

## 数据与指标

| 数据集 | 输入 | 指标 |
| --- | --- | --- |
| RepoQA | 官方 2024-06-23 snapshot，60 个 scope、600 题 | 文件 Hit@1/5/10/100、MRR@10；去重源码在 2000/8000 个 o200k tokens 内的目标行覆盖 |
| CoSQA | 官方 retrieval-test-500，6267 个代码候选 | 按原 snippet 文件计算 Hit@1/5/10/100、MRR@10 |
| EverTrace | Git 已跟踪的现存文件与未忽略的未跟踪文件，实体复制 | 完整首建、真实命中、结果一致性；没有人为构造的相关性金标 |

公开任务沿用此前检索适配：RepoQA 最多返回 50 个 passage，CoSQA 最多 100 个。
文件排名按 passage 中第一次出现的文件去重；Hit@100 也受这些输出上限约束。
RepoQA 覆盖只计完整落入 token 预算的源码行；这不是官方代码生成/SNF 分数。
失败或超长 query 计入分母，记为 miss；原始 query 保留原文。

`panel.json` 固定原来的 120 题延迟 panel：RepoQA 每 scope 一题、CoSQA60 题。
EverTrace 使用 `datasets.py` 的五条固定查询。任何抽样修改须作为新协议另报。
输入、查询和金标分开保存，搜索 scope 中仅有源码。

## 准备

需要 Linux x64、系统 Python 3.12+、uv、Git、rg，以及已准备好的完整 semantic runtime bundle。
bundle 应包含 `bin/sgrep`、配套 `lib/`、`models/`、`parsers/` 和 `assets.json`。
采用 semantic README 中的正式构建/staging 流程；这里不会编译或下载模型。

下列命令从仓库根目录运行。依赖使用实体副本安装到私有目录，避免 venv/包的链接组装：

```sh
mkdir -p .work/semantic-benchmark
uv pip install --python /usr/bin/python3.12 --target .work/semantic-benchmark/python \
  --link-mode copy -r benchmarks/semantic/requirements.txt
export PYTHONPATH="$PWD/.work/semantic-benchmark/python"
export TIKTOKEN_CACHE_DIR="$PWD/.work/semantic-benchmark/tokenizer-cache"
```

首次加载 o200k 编码表时，tiktoken 会下载自己的评估资源；后续复用本地缓存。
这是评分器资源，与被测模型和 CLI 耗时分开。

公开输入来自：
- [RepoQA](https://github.com/evalplus/repoqa)，参考提交 `ae876deb1365dbf5a15b0533723c8ed123eee586`；
  官方数据文件放在 `references/repoqa/data/repoqa-2024-06-23.json`。
- [CoCLR/CoSQA](https://github.com/Jun-jie-Huang/CoCLR)，参考提交
  `14ebcacf9e9bc3e7109102632bc63047876f27d2`；使用 `data/search/` 下的两个检索文件。

数据和第三方源码保持各自的上游许可，均未复制进本工具的 Git 目录。
新 clone 可按以下方式取得输入；已有 references 时跳过：

```sh
git clone https://github.com/evalplus/repoqa.git references/repoqa
git -C references/repoqa checkout ae876deb1365dbf5a15b0533723c8ed123eee586
mkdir -p references/repoqa/data
curl --fail --location --output .work/semantic-benchmark/repoqa.json.gz \
  https://github.com/evalplus/repoqa_release/releases/download/2024-06-23/repoqa-2024-06-23.json.gz
gzip -dc .work/semantic-benchmark/repoqa.json.gz > references/repoqa/data/repoqa-2024-06-23.json
git clone https://github.com/Jun-jie-Huang/CoCLR.git references/cosqa
git -C references/cosqa checkout 14ebcacf9e9bc3e7109102632bc63047876f27d2
```

准备完整语料：

```sh
uv run --no-project --python /usr/bin/python3.12 python -B benchmarks/semantic/benchmark.py prepare \
  --output .work/semantic-benchmark/data --evertrace /absolute/path/to/EverTrace
```

目录必须是新的。准备程序核对完整题数、gold/代码映射、UTF-8 byte/line span 和可见文件。
EverTrace 复制时拒绝链接与复制期间的变化，记录源提交、dirty 状态、路径列表和字节数。
逐文件检查复制期间的变化；副本包含当前未提交内容。之后只搜索副本，运行期间保持副本原样。

## 运行入口

### 先验证工具与真实首建

```sh
uv run --no-project --python /usr/bin/python3.12 python -B benchmarks/semantic/selftest.py \
  --work .work/semantic-benchmark/selftest
uv run --no-project --python /usr/bin/python3.12 python -B benchmarks/semantic/benchmark.py run \
  --data .work/semantic-benchmark/data --output .work/semantic-benchmark/smoke \
  --control /absolute/path/to/runtime --mode latency --smoke --warm-repeats 1
```

`--smoke` 每数据集只取一个完整 scope 和一题。EverTrace 仍处理完整快照。
这能检查入口、真实 publication、H 和回收，不能作为 1100 题质量或正式性能结论。
运行目录也必须是新的；失败记录保留，程序没有自动重跑或续跑逻辑。

### 完整质量：与计时分开

```sh
uv run --no-project --python /usr/bin/python3.12 python -B benchmarks/semantic/benchmark.py run \
  --data .work/semantic-benchmark/data --output .work/semantic-benchmark/quality \
  --control /absolute/path/to/control --candidate /absolute/path/to/candidate \
  --mode quality --datasets repoqa cosqa
```

每个 scope/每臂有独立 HOME、quota ledger、索引与服务；scope 内复用缓存。
质量测试启用完整 retrieval trace，保存所有候选分数、各 Top200、union 和最终顺序。
A/B 分别评分，按 query 比较 stdout 和 trace 字段；差异使一致性检查失败，保留两臂指标供分析。
它覆盖 CLI 检索结果层；原始 FP32/FP16 embedding 的内核级资格仍应复用对应 Native 检查。
质量调用的耗时仅作诊断。超长 query 即使两臂同样拒绝，也会进入失败列表与完整题数分母；
此时 `passed=false` 表示有请求失败，是否属于新回退应结合两臂拒绝记录判断。

### 配对首建和暖查询

```sh
uv run --no-project --python /usr/bin/python3.12 python -B benchmarks/semantic/benchmark.py run \
  --data .work/semantic-benchmark/data --output .work/semantic-benchmark/latency \
  --control /absolute/path/to/control --candidate /absolute/path/to/candidate \
  --mode latency --pairs 6 --aa-pairs 3 --warm-repeats 6 --budget 512
```

默认覆盖三个数据集。每个 scope/trial 使用新进程、新 HOME、空索引、已备离线资产：
1. panel 的首题完成建库，要求 `cache_hit=false`、完整 scope 编码、零 record 复用、`published=true`。
2. 立即重复首题，要求真实 H、所有文档编码计数为零，stdout 与首建相同。
3. 在同一索引和暖服务上执行该 scope 的剩余 panel query；每题固定重复次数。

建库失败时跳过其暖查询，原始失败仍保留。暖查询失去命中时停止该 trial 的后续暖样本。
各臂按 pair 交错 A/B、B/A；A/A 用控制 bundle 的两个独立生命周期，全部顺序预先写入身份记录。
这是 sequential paired 实验，并发吞吐另测。完整矩阵耗时较长，先用 smoke 确认环境。
模型 bundle 只读复用；独立 trial 的索引和原始记录全部保留，总磁盘占用会累积到多 GiB，执行前预留空间。

单 bundle 也可运行；此时只描述基线，无法声称提速。
`--datasets` 可显式选子集；`--budget` 支持 256/512/1024，默认 512。
256/1024 用于补充预算和回退检查，主要性能表保持默认档位。
`--control-build` / `--candidate-build` 可附已有 JSON 构建记录。
每个调用默认 600 秒超时，父进程用 pidfd 等待真实退出，超时后停止自有服务。
同一工作副本通过 `.work/semantic-benchmark/performance.lock` 防止重复启动 benchmark；
其它工作副本和外部实验仍需自行协调。

## 计时和通过条件

- 首建墙钟：正常 shared CLI 从启动到进程退出，RAW 时基，包括新服务启动。
- 暖查询墙钟：相同入口，模型和索引已就绪。
- 同时记录 MONOTONIC；相对 RAW 偏差超过 1% 的计时样本标为无效。
- `--no-cache` 与物理冷页测试另属场景，本工具当前只测已备资产的进程冷首建和暖模型命中。
- 启用既有 stage/service/publication 诊断；计时阶段关闭 retrieval trace。
  当前三段字段还是历史聚合口径：
  `source_lexical_us` 含缓存探测；
  `documents_us` 含锁、分词、前向、sink 等；
  `exact_rank_us` 含排名、最终复核与发布。
  它们只能解释大阶段，细粒度分段归因是 #27 的后续工作。
- RSS/HWM 是服务请求后快照，见 `service.status`；既非全进程组峰值，也非硬内存验收。
- summary 的 `passed` 只表示本轮入口、结果与一致性检查通过，性能采用由人审阅。
  查看固定配对差、均值、中位数、样本方差及 A/A 波动；各 scope 单列，失败样本单列。
  小样本只报原始分布，不给出可靠性不足的 P95/P99。

## 输出

- `harness/`：本轮实际使用的 benchmark 源文件、固定 panel 与依赖说明副本，保留开发时的 dirty 版本。
- `identity.json`：顺序、配置、系统、scope、bundle 路径/元数据、已有 catalog 与构建记录。
  源码 HEAD 属于 benchmark 仓库；bundle 的 SOURCE_COMMIT 及构建记录单独保留。
  每个服务另保存真实 exe、映射库路径和状态，核对加载的是指定 Native/ORT。
  编译器与 flags 由已有构建记录提供；省略构建记录时该项留空，正式采用前应补齐。
  工具复用既有模型身份，不额外反复 hash 模型。
- `runs/*/`：私有 profile、逐调用命令、stdout/stderr、阶段/发布诊断、质量 trace、服务退出记录。
- `records.jsonl`：逐调用日志，异常时保留已完成内容；
  `records.json`：收口后的调用记录（含首建后 H 验证状态）。
- `comparisons.json`、`summary.json`：数值/工作量比较、公开任务指标、配对时间与失败列表。

数据和所有输出都放在搜索 scope 外。生产模型、个人配置、原仓库和已有索引保持原样。
工具不会清系统页缓存、修改系统时钟或自动发布资产。
