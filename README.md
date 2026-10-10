# Echo Performance

Part of the Echo Series. An experimental, reversible long-chat extension for SillyTavern.

Current development version: `0.1.0-alpha.1`. Target host for validation: SillyTavern `1.18.0`, commit `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`. No release has been published.

## 当前阶段

当前 feature 分支正在验证 **Echo DOM Compact Prototype**。

上一阶段 `acceptance-v2` 已完成真实 SillyTavern 200 / 500 / 1000 楼验收。旧方案使用 `content-visibility` 延后部分远处消息的布局与绘制，但没有真正减少 live DOM，因此整体仍为 **PARTIAL**，默认关闭，也不能称为正式性能优化完成。

Phase 3 改为验证另一条路线：

- 聊天原始数据始终完整保留；
- 最近约 100 楼作为热区持续留在 live DOM；
- 热区之前保留约一个 50 楼 chunk 作为初始温区；
- 更早的普通消息节点按约 50 楼分 chunk，从 `#chat` 真正 detach；
- detached 消息保留原始 DOM 节点和直接 listener，不销毁、不重新 render；
- 每个冷 chunk 只在 live DOM 中留下一个空白高度 spacer，用来保持滚动几何；
- 接近历史 chunk 时原样插回节点，并通过滚动锚点修正 `scrollTop`；
- 对原生 `showMoreMessages()` 造成的临时历史重渲染进行 reconciliation，优先恢复 Echo 已缓存的原节点，避免长期重复 DOM；
- 提供 `EchoPerformance.ensureMessageMounted(mesId)`，供兼容验证及需要访问冷区消息的操作在执行前临时恢复对应 chunk；
- 真实 generation started 时冻结 compact，确保最后消息 mounted；`dryRun=true` 完全忽略；generation ended / stopped 后重新 reconcile 并继续 compact。

这不是完整虚拟列表。第一版刻意不销毁历史节点，也不接管 SillyTavern 的 render pipeline。

## 使用

将本目录安装到酒馆的 `public/scripts/extensions/third-party/echo-performance`，刷新页面，在扩展设置中打开 **Echo Performance → DOM Compact Prototype（实验功能）**。

功能默认关闭。实验阶段不要把它当作稳定功能长期使用。

可以通过：

```js
EchoPerformance.stats()
```

查看当前 live / detached 消息数量、chunk 数量、最近 restore 样本和滚动漂移。

需要临时恢复某条消息时：

```js
EchoPerformance.ensureMessageMounted(mesId)
```

需要让某条消息始终留在 live DOM 时：

```js
EchoPerformance.pin(messageElement)
```

查找、全选和打印会恢复全部消息并暂停 compact。可以从设置面板重新继续。

## 明确边界

- 不删除 `chat` 数据，不改聊天文件。
- 不修改世界背面源码。
- 不使用 `display:none`、`hidden class`、`visibility:hidden` 或仅排除上下文来冒充 DOM 压缩。
- 不重写 Markdown、reasoning、保存队列、fetch、全局事件或 SillyTavern render pipeline。
- 不销毁 cold DOM 后重新 render。
- 含活动 iframe、video、audio、canvas、contenteditable 或正在编辑输入框的消息暂不 detach；这类消息可能让 live 数量高于目标值。
- 原生和第三方代码如果直接假设“所有聊天历史 `.mes` 永远同时存在于 `#chat`”，仍需要专项兼容验证。
- 当前 Phase 3 尚未完成真实酒馆性能验收，状态为 **NOT VERIFIED**。不能因为实现代码已存在就写成 PASS。

上一阶段真实结果保留在 `docs/acceptance-v2.md` 与 `evidence/acceptance-v2/`，不得覆盖或美化。

## Phase 3 smoke gate

`.lab/dom-compact-smoke.mjs` 是 Phase 3 的第一道真实酒馆门槛，只回答原型是否值得进入完整 profiling。

它在 200 / 500 / 1000 楼做 Echo OFF / ON 对照，重点检查：

- live `.mes` 数量；
- `#chat` element / node 数；
- 整页 node 数；
- detached chunk 数；
- `ensureMessageMounted()`；
- restore 后 swipe；
- restore 后 edit 打开 / 取消；
- restore 后 reasoning 展开；
- 原生 `/chat-jump` 定位历史消息；
- 原生 regenerate；
- generation started / ended 状态机；
- restore duration；
- scroll position drift。

1000 楼 smoke 只有在 live `.mes` 收缩到约 180 以下，并且 `#chat` element 与整页 node 数出现数量级上有意义的下降，同时原生交互通过、scroll drift 控制在很小范围内，才允许给 smoke gate 判 PASS。

**Smoke PASS 只代表值得继续完整 Phase 3 profiling，不代表插件稳定、不代表允许 merge main 或发布 release。**

## 完整 Phase 3 验收

真实验收仍必须使用 `h675786161-prog/sillytavern-lab` 的真实 SillyTavern 1.18.0 环境，不能用 mock HTML 或概念页面代替。

完整验收需要继续采集：

- initial load；
- style recalculation；
- layout；
- paint；
- long task 次数和总耗时；
- 真实鼠标滚轮 frame interval / dropped frame；
- chunk restore 耗时；
- scroll drift；
- restore 后 swipe / edit / reasoning / regen；
- 刷新重入状态；
- 世界背面自动隐藏、世界状态与 regen 兼容。

世界背面只作为兼容对象，不得修改源码。Echo OFF 下也发生的 revision / summary 重建不能归因 Echo。

结果统一使用：`PASS` / `PARTIAL` / `FAIL` / `NOT VERIFIED`。

在真实 1000 楼 DOM 数量显著下降且原生交互仍正常之前，禁止宣称：

`PASS — DOM Compaction Prototype`

## 开发与发布规则

当前工作只允许留在 feature 分支：

`feature/echo-performance-long-chat`

不要 merge main，不要发布 release，不要把实验结果包装成稳定版。

运行静态检查：

```bash
npm run check
```

feature 分支包含最小 GitHub Actions 静态检查工作流；如果 Actions 没有实际运行，状态仍按 `NOT VERIFIED` 处理。
