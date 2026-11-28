# 架构决策

## Working 行与转录显示的所有权

Working 状态是 `ctx.ui.setWidget` 的 above-editor widget。Widget 安装成功后，Metis 隐藏 Pi 的原生 loader；安装失败或宿主缺少接口时，原生 loader 继续显示。常规 token 和缓存统计归元数据和 footer，Working 行的 token 展示可选。转录叶组件消费宿主注入的布局和颜色能力；Pi 组件安装、事件适配和可卸载的包装归 `appearance`，宿主类绑定限定在适配层。

Working 行的布局与动效参考 Codex 的 `status_indicator_widget.rs`。动画定时器与秒级计时分开，tick 只推进帧并请求渲染；会话用量和磁盘读取由其他所有者负责。每波扫过完整文字和拖尾后停顿；帧间隔与每帧移动距离分别控制刷新频率和扫动速度。颜色或动效受限时使用静态展示；settle 和 dispose 停止动画定时器。快照由 getter 提供，渲染组件复用该状态。

**实现与测试：** [`working.ts`](../src/appearance/chrome/working.ts)、[`install.ts`](../src/appearance/chrome/install.ts)、[`transcript-components.ts`](../src/presentation/components/transcript-components.ts)、[`working.test.mts`](../test/core/working.test.mts)。

## 工具行保留 Pi 的原生组件树

Pi 在工具行构造时根据 shell 选择子组件。Appearance 保留这一步的原生选择，等首次渲染时再切换到自绘；禁用或卸载就能回到原生渲染，不用重排子组件、鼠标区域或改写图片处理。

**实现与测试：** [`tool-host-adapter.ts`](../src/appearance/tool-host-adapter.ts)、[`adapter.test.mjs`](../test/contract/adapter.test.mjs)。

## 终端渲染共享颜色能力

Appearance 首次安装时解析并缓存终端颜色能力；编辑器边框、转录分隔线和思考提示共用同一结果。这样各渲染路径不会对同一终端做出不同选择，重绘也不会反复探测宿主。

**实现：** [`extensions/appearance.ts`](../extensions/appearance.ts)。

## Recall Query 先保留会话首尾

会话超预算时，先给开头的设置和结尾的结果预留空间，再按问题匹配挑选中段。首尾预留让模型同时看到原始约束和最终决定，关键词排名负责中段选择。首尾较大的消息按预算截段，并标记截段和遗漏；最终请求再校验预算。

**实现与测试：** [`context.ts`](../src/pi-session-recall/context.ts)、[`session-recall.test.mts`](../test/io/session-recall.test.mts)。

## Bright Data 诊断文本与供应商回退

HTTP 状态由 `SearchHttpError.status` 提供，响应正文只用于展示。代理返回 HTTP 200 后，有效 JSON 且 envelope 成功才返回 SERP；其他响应进入失败路径，正文中的状态或配额文字不参与供应商切换。旧供应商抛出的普通 `Error` 继续按文本分类，包括配额错误。

Bright Data 的展示文本先脱敏，再裁剪和重写可能类似 HTTP 状态或配额信息的片段。先裁剪可把四位数字变为三位状态码，因此重写放在裁剪之后。长度上限适用于原始引用；重写后的文本按诊断结构调整。

V8 解析异常仅使用结构化错误信息；正文片段排除在诊断之外，因为凭据替换无法识别其前缀。传输诊断保留取消语义并脱敏。凭据解析可能执行命令，因此先验证 zone，再解析凭据。

**实现与测试：** [`brightdata.ts`](../src/pi-web-access/brightdata.ts)、[`search-router.ts`](../src/pi-web-access/search-router.ts)、[`brightdata-serp.test.mjs`](../src/pi-web-access/test/brightdata-serp.test.mjs)。
