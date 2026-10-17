# 子代理模块分层

按运行位置和状态所有者分目录，不以 `core` 笼统包裹不同进程的实现。

```text
subagents/
├── host/                         父 Pi 进程中的会话协调
│   ├── runtime-package.ts        定位后端资产，读取生成的工具元数据
│   ├── client.ts                 Python host 连接、JSONL 请求与取消
│   ├── session.ts                父会话租约、操作身份、通知与交付证明
│   └── sampling.ts               原生采样边界的通知让行
├── ui/                           渲染、状态组件与会话查看器
├── backend/                      Python 服务
│   ├── main.py                   私有进程入口：pi-host 或 daemon
│   ├── tools.json                从 schema.py 生成的元数据，不手工维护
│   └── metis_subagent/
│       ├── paths.py              包内资产位置的唯一定位处
│       ├── pi_host.py            父 Pi JSONL 与 daemon IPC 之间的桥
│       ├── daemon.py             IPC、准入与空闲退出
│       ├── runtime.py            agent/run 状态转换的唯一推进者
│       ├── store.py              SQLite 事务、结果和请求身份
│       ├── worker.py             子进程协议、存活与清理
│       └── worker_guard.py       进程租约、后代回收与清理证明
└── worker/                       子 Pi 进程中的执行组件
    ├── pi-sdk.mjs                启动未修改的 Pi SDK 并绑定任务协议
    ├── task-queue.mjs            当前任务、取消和 SDK 输入归属
    ├── protocol-output.mjs       唯一协议输出及背压
    ├── network.mjs               子进程的代理网络初始化
    └── managed-surface.ts        按真实工具来源应用 profile 权限
```

## 调用与依赖边界

`extensions/subagents.ts` 装配 `host` 与 `ui`。`host/session.ts` 通过
`host/client.ts` 调用 `backend/main.py pi-host`；桥接进程再连接共享 daemon。
后端持有持久状态并启动 guard，guard 启动 `worker/pi-sdk.mjs` 执行任务。
`ui` 仅展示传入数据并通过回调请求操作，不直接访问账本或启动进程。

Python 包命名空间保留 `metis_subagent`；`backend` 是交付位置，不是另一层
运行时服务。`worker` 不读写后端 SQLite。父会话关闭连接不代表任务结束，
取消请求不代表进程已清理，工具回复也不等于父 Pi 已保存交付证明。
这些时序和失败语义仍由原来的所有者管理，不通过目录重组改变。

## 代码资产与用户状态

`backend/metis_subagent/paths.py` 只定位包内代码和默认模板，不发现或迁移
用户数据。`host/runtime-package.ts` 只定位后端及元数据。配置仍是全局
`metis-pi.toml`，用户状态仍在 `<agentDir>/metis/subagent/`；目录重组不改变
scope、会话记录、数据库格式或已保存的请求身份。启动时仅将保存 argv 中
后端拥有的第一个扩展槽位绑定到当前包内权限扩展，兼容包目录移动；用户
profile 扩展、模型和推理参数不重写，原始账本记录不改动。

修改工具 schema 后运行 `npm run prepare:subagents`。源码指纹覆盖 Python
后端、私有入口、全部 worker 代码和默认模板；驻留 daemon 不会因磁盘更新
自动升级，应先让任务结束并正常停驻，再重新加载。
