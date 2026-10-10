# Echo Performance

Part of the Echo Series. An experimental, reversible long-chat extension for SillyTavern.

Current development version: `0.1.0-alpha.1`. Tested host: SillyTavern `1.18.0`, commit `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`. No release has been published.

## 使用

将本目录安装到酒馆的 `public/scripts/extensions/third-party/echo-performance`，刷新页面，在扩展设置中打开 **Echo Performance → 长聊天按需显示**。

功能默认关闭。打开后，150 楼起延后远离视口的普通楼层布局和绘制，最近 40 楼与视口前后 2000 像素保持原样。进入相应位置时由浏览器恢复绘制；操作该楼或关闭开关时，移除布局限制。

聊天原始数据、swipe 历史、reasoning 和聊天文件仍由酒馆保存。所有消息外壳、正文节点、编号、操作按钮和 reasoning 区域始终保留。生成期间暂停优化；原生聊天、编辑、swipe 和渲染事件执行前移除全部布局限制，随后重新安排优化。

含媒体、iframe、输入框、代码块按钮、自定义标签或属性的正文跳过。扩展可在消息外壳或正文上添加 `data-echo-keep`，或调用 `EchoPerformance.pin(shell)`，保持该楼原样。

浏览器查找快捷键、全选、打印和跨文本选择会恢复常规显示并暂停，之后可点击“继续按需显示”。正文 DOM 始终完整；布局敏感的插件可在操作前调用 `EchoPerformance.restoreAll()`，操作结束后按需调用 `resume()`。未知插件、浏览器、主题与无障碍工具仍需专项验证。

## 边界

- 使用 `content-visibility: auto` 和实测楼层高度延后浏览器的布局与绘制，不拦截原生初次消息格式化，所以不承诺缩短首次打开聊天的时间。
- 正文节点移出页面的原型虽然降低了 DOM 数量，却显著拖慢快速滚动，已移除。交付版本不会减少 DOM 总数、聊天文件大小，也不承诺降低 JavaScript 堆内存。
- 没有修改原生保存队列、聊天截断设置、reasoning 渲染或 swipe 数据。
- 默认关闭；最新 200/500/1000 楼性能与自动整理/隐藏验收以 `docs/acceptance-v2.md` 为准，状态为 PARTIAL。`docs/validation.md` 保留第一轮历史结果。未知插件不能视为已验证兼容。

## 本地验收

使用实验环境 `h675786161-prog/sillytavern-lab`（GitHub 当前跳转到 `h675786161-prog/lab`）规定的固定 SillyTavern commit，并用独立数据目录启动服务。不要使用日常酒馆或真实聊天。

测试需提供 Playwright Core 和 Chrome/Edge：

```text
LAB_ST_URL=http://127.0.0.1:8039
LAB_PLAYWRIGHT_CORE_ENTRY=<absolute path to playwright-core/index.mjs>
LAB_CHROME=<absolute path to Chrome or Edge>
LAB_EVIDENCE_DIR=<isolated output directory>
```

运行 `npm run check`，然后按顺序运行 `.lab/benchmark.mjs`（`ECHO_MODE=baseline`）、同一脚本（`ECHO_MODE=optimized`）和 `.lab/runtime-smoke.mjs`。基准脚本通过酒馆真实角色和聊天 API 创建合成测试数据；兼容性测试使用这些数据。不要同时运行多个性能测试浏览器。

正式对照另外运行 `.lab/benchmark.mjs`（`ECHO_MODE=paired`），每档每种模式三次交替测试。安装报告中指定版本的世界背面、关闭其自动模型任务和旧楼自动隐藏后，运行 `.lab/runtime-smoke.mjs`（`ECHO_COMPAT=1`）。再运行 `.lab/settings-smoke.mjs` 和 `.lab/upstream-control.mjs`；最后用 `.lab/report.mjs` 从这些记录生成报告。首次启动需要完成酒馆欢迎步骤。完整结果见 [验收记录](docs/validation.md)。

以上是第一轮的有限兼容检查，不能证明自动整理/自动隐藏兼容。第二轮先用 `ECHO_COUNTS=200,500,1000`、`ECHO_MODE=paired`、`LAB_EVIDENCE_DIR=<本项目>/evidence/acceptance-v2` 运行基准，再运行 `.lab/acceptance-v2.mjs`。该脚本通过本地可控 HTTP provider 实际触发开启的自动整理/隐藏及原生重生成；不连接外部模型，不证明模型摘要质量。随后运行 `.lab/world-refresh-control-v2.mjs`、`.lab/archive-metrics-v2.mjs`、`.lab/analyze-world-v2.mjs` 和 `.lab/acceptance-v2-report.mjs`。测试过程只使用隔离合成聊天，目标自动功能保持开启。必须检查完整逐次记录，不能将 PARTIAL 当作全部兼容通过。

模型生成链路测试使用确定性接口回复，验证的是原生生成、事件、数据和保存流程，不是外部模型服务的质量或连通性。
