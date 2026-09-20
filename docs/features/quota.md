# Codex 额度（只读）

> 经本机已登录 Codex CLI 的 `codex app-server` 读取真实额度，只读、可失败、绝不影响 agent 交互。

| | |
| --- | --- |
| 入口 | `extensions/appearance.ts` |
| 实现 | `src/quota/codex-app-server.ts`（查询）`src/quota/normalize-codex.ts`（归一化）`src/quota/quota-store.ts`（编排）`src/quota/types.ts`（类型） |
| 显示 | footer 的 `Codex 5h 82% · week 64%` 段（`footer.showCodexQuota`） |
| 配置 | `quota.codex`（auto/on/off）、`quota.refreshSeconds`（30..3600，默认 120）、`quota.timeoutMs`（1000..60000，默认 8000） |
| 诊断 | `/codex-ui`、`/codex-ui refresh-quota` |

## 数据来源（唯一一条）

```
codex app-server  ← stdio JSON-RPC
  initialize → initialized → account/rateLimits/read
```

- **不读**任何凭据文件、**不发**私有 HTTP、**不 scrape** Codex TUI——只跟本机已登录的 Codex CLI 说话。
- CLI 不在 / 未登录 / 启动失败 → 归入有界错误类别，显示 `—`，不报错弹窗。

## 显示与口径

- `remaining = 100 − used`，**永不混用方向**（`src/quota/types.ts` 的 `remainingPercent` 永远这样推导）。
- 两个窗口：`primary`（短的 5 小时窗，footer 的 `Codex 5h N%`）与 `secondary`（周窗，`week N%`）；另有 `planType` 与 `credits`。
- 未知值显示 `—`，不伪造 0。

## 失败分类（有界）

`QuotaErrorClass`（`src/quota/types.ts`）：

| 类别 | 含义 |
| --- | --- |
| `codex-missing` | 找不到 codex CLI |
| `startup-timeout` | app-server 启动超时 |
| `rpc-timeout` | 请求超时（受 `quota.timeoutMs` 约束） |
| `rpc-error` | app-server 返回错误响应 |
| `early-exit` | 进程提前退出 |
| `no-data` | 响应里没有可用的额度字段 |

诊断只显示**类别**，从不显示原始响应体。

## 刷新策略

- 单飞行（single in-flight）：并发请求合并到同一个 Promise，不会叠加进程。
- 失败**保留上一次好快照**并标记 stale，而不是清零（`src/quota/quota-store.ts`）。
- 轮询由 `quota.refreshSeconds` 驱动；`/codex-ui refresh-quota` 可手动触发一次。
- `quota.codex: "auto"` = 能读到才显示；`"on"` 强制；`"off"` 关闭。

## 代码位置

| 关注点 | 位置 |
| --- | --- |
| stdio JSON-RPC 客户端 | `src/quota/codex-app-server.ts` |
| 响应归一化（camelCase → 显示类型） | `src/quota/normalize-codex.ts` |
| 单飞行/保留上次好值 | `src/quota/quota-store.ts` |
| 类型与错误类别 | `src/quota/types.ts` |
| footer 段落 | `src/chrome/footer.ts` |
| 定时刷新接线 | `src/extension.ts`、`src/diagnostics.ts` |

## 不变量与已知限制

- **读不到就显示 `—`**：quota 失败绝不影响 agent 交互、终止判定（`Worked`/`Failed`/…）或任何其他显示块。
- 不解析 TUI 文本、不猜数值；只有 app-server 明确给出的字段会被显示。
- 额度读取**不会**因为一次失败而停摆：下次轮询照常尝试。
- 依赖本机 Codex CLI 的登录状态；未安装时该段静默缺席。

## 验证

`test/quota.test.mts`（217 行：归一化、错误类别、单飞行、stale 保留、`remaining` 方向）。
