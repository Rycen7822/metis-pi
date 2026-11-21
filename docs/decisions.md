# 架构决策

## Working 行与转录显示的所有权

Working 状态是 `ctx.ui.setWidget` 的 above-editor widget。只有 widget 安装成功才隐藏 Pi 的原生 loader；失败或没有该宿主接口时仍由原生 loader 显示。常规 token 和缓存统计归元数据和 footer，Working 行的 token 展示可选。转录叶组件只消费宿主注入的布局和颜色能力；Pi 组件安装、事件适配和可卸载的包装归 `appearance`，不在渲染组件里绑定宿主类。

Working 行的布局与动效参考 Codex 的 `status_indicator_widget.rs`。动画使用与秒级计时分离的活动期定时器。动画 tick 只推进帧并请求渲染，不重新读会话用量或磁盘。每波扫过完整文字和拖尾再停顿，帧间隔与每帧移动距离分开，以免提高刷新频率必然加快扫动。无颜色、低色深或禁用动效时回退到静态展示；settle 和 dispose 停止动画定时器。快照由 getter 提供，组件渲染不另存一份状态。

**实现与保护：** [`working.ts`](../src/appearance/chrome/working.ts)、[`install.ts`](../src/appearance/chrome/install.ts)、[`transcript-components.ts`](../src/presentation/components/transcript-components.ts)、[`working.test.mts`](../test/core/working.test.mts)。

## Recall Query 先保留会话首尾

会话超预算时，先给开头的设置和结尾的结果留少量空间，再按问题匹配挑选中段。仅按关键词排名可能挤掉这两处，导致模型读到过程却看不到原始约束或最终决定。首尾较大的消息也只保留预算内的截段，所有截段和遗漏都显式标记；整条请求仍要复核预算。

**实现与保护：** [`context.ts`](../src/pi-session-recall/context.ts)、[`session-recall.test.mts`](../test/io/session-recall.test.mts)。

## Bright Data 诊断文本与供应商回退

HTTP 非成功状态使用 `SearchHttpError.status`，不是从响应文字里猜。代理返回 HTTP 200 时仍可能没有可用 SERP；无效 JSON 或错误 envelope 必须显示为失败，不能当空结果，也不能因正文中的状态或额度措辞触发另一家付费请求。路由仍兼容旧供应商的普通 `Error`，这些错误会走文本分类，包括针对 quota 的判断。Bright Data 因此重写展示片段中形似状态或额度的内容。应裁剪后再重写，避免裁剪把四位数字变成看似有效的三位状态；上限限制的是引用原文的长度，不是重写后的总长度。

引用的响应本文和 envelope 错误先脱敏，再裁剪和转换；不引用 V8 解析异常的正文片段，因为凭据前缀无法被完整凭据替换规则匹配。传输诊断保留其取消语义，但也必须脱敏。先验证 zone，再解析可能执行命令的凭据，避免无效设置启动命令或触发计费。

**后续：** 让 `brightdata.ts` 的 `invalidResponse` 和共享路由传递带类型的失败类别，将 `untrustedText` 的展示职责与回退分类解耦。在改变诊断转换前，保留凭据脱敏、取消和付费失败测试。

**实现与保护：** [`brightdata.ts`](../src/pi-web-access/brightdata.ts)、[`search-router.ts`](../src/pi-web-access/search-router.ts)、[`brightdata-serp.test.mjs`](../src/pi-web-access/test/brightdata-serp.test.mjs)。
