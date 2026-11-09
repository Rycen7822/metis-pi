# 子代理模块分层

按运行位置和状态所有者分目录，让每个进程的实现在自己的目录里。

```text
subagents/
├── host/                         父 Pi 进程中的会话协调
│   ├── runtime-package.ts        定位后端资产，读取生成的工具元数据
│   ├── client.ts                 Python host 连接，JSONL 请求与取消
│   ├── session.ts                父会话租约、操作身份、通知与交付证明
│   └── sampling.ts               原生采样边界的通知让行
├── skills/subagent-delegation/    随父模块启用的委派指导，独立于公共 skills 扫描
├── ui/                           渲染、状态组件与会话查看器
├── backend/                      Python 服务
│   ├── main.py                   私有进程入口：pi-host 或 daemon
│   ├── tools.json                从 schema.py 生成的元数据，由脚本维护
│   └── metis_subagent/
│       ├── paths.py              包内资产和默认模板的唯一定位处
│       ├── pi_host.py            父 Pi JSONL 与 daemon IPC 之间的桥
│       ├── daemon.py             IPC、准入、空闲退出
│       ├── runtime.py            agent/run 状态机的唯一推进者
│       ├── store.py              SQLite 事务、结果和请求身份
│       ├── worker.py             子进程协议、存活与清理
│       └── worker_guard.py       进程租约、后代回收与清理证明
└── worker/                       子 Pi 进程中的执行组件
    ├── pi-sdk.mjs                启动未改的 Pi SDK，绑定任务协议
    ├── task-queue.mjs            当前任务、取消和 SDK 输入归属
    ├── protocol-output.mjs       唯一协议输出，带背压
    ├── network.mjs               子进程的代理网络初始化
    └── managed-surface.ts        按真实工具来源执行 profile 权限
```

## 调用与依赖边界

`extensions/subagents.ts` 装配 `host` 和 `ui`。`host/session.ts` 经
`host/client.ts` 调 `backend/main.py pi-host`，桥再连共享 daemon。
后端持有持久状态并启动 guard，guard 启动 `worker/pi-sdk.mjs` 执行任务。
`ui` 只展示传入数据，操作通过回调请求；账本访问和进程启动都在后端。

Python 包名保留 `metis_subagent`；`backend` 是交付位置，运行时服务只有一层。
`worker` 与后端 SQLite 数据相互独立。父会话关闭连接后任务继续运行，
取消请求发出后由 guard 负责清理确认，工具回复之后由 session 层保存交付证明。
这些时序和失败语义各归其 owner，目录重组保持现状。

## 会话查看器样式

`ui/viewer.ts` 左边只画一条 `▏`，和 codemode 共用橙色 `#d97706`；弹窗沿用编辑器暗灰底 `#1f1f1f`。
上、右、下三边省去外框，靠背景色区分。功能滚动条在右侧内缩一列，拖拽、滚轮、键盘照用；标签页和关闭按钮在第 0 行。
正文字体、字号、字重、列宽与编辑器一致。共享背景绘制在内部样式复位后恢复灰底，diff 这类显式背景保留。
元信息按“模型／思考深度 · read/write 权限 · 工作路径”显示，随可用列宽换行；权限取保存的实际启动配置。

## 代码资产与用户状态

`backend/metis_subagent/paths.py` 定位包内代码和默认模板，用户数据的发现和迁移由宿主负责。
`host/runtime-package.ts` 定位后端和元数据。配置在全局 `metis-pi.toml`，
用户状态在 `<agentDir>/metis/subagent/`；目录重组之后 scope、会话记录、
数据库格式和已存请求身份保持原格式。

启动时只把保存 argv 中后端占用的第一个扩展槽位绑定到当前包内权限扩展，兼容包目录移动；
用户 profile 扩展、模型和推理参数沿用原值，原始账本保持原样。

修改工具 schema 后运行 `npm run prepare:subagents`。运行身份覆盖 Python 后端、
私有入口、全部 worker 代码和规范化后的 `[subagents]` 默认值；其他模块配置、
TOML 注释、表顺序不计入身份，摘要逻辑只有一份。

宿主重载只关闭自己的 bridge，其他父会话的任务继续运行。新 bridge 发现运行身份
有差异时，先 ping 协商空闲交接，再带原 PID/revision 请求 `shutdown(if_idle)`。
daemon 在同一事件循环内检查任务、resident 和已接纳操作后关闭准入；忙碌时拒绝，
由 doctor 诊断和显式 stop 处理。旧版缺少该能力时改用受控过渡流程，运行中的后台
等其自然退出或由用户显式停止。ping/doctor 诊断随时可运行，后台按需启动。

历史 `cleanup=unknown` 继续隔离可能的写入者，空 daemon 的存活依赖活跃任务；
重启保留记录，verified 标记只来自真实清理。初始化的版本拒绝可重连，
未知连接丢失或变更回复留在队列中等待确认。
