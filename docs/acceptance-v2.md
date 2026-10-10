# Echo Performance 长聊天真实性能验收第二轮

整体状态：**PARTIAL**。开发分支 feature/echo-performance-long-chat。没有正式 release，没有推送远端。

报告日期：2026-10-10（Asia/Shanghai）；测试跨 2026-10-09 夜间及 10 日。PASS=具体指标完成采集或明确行为断言通过；PARTIAL=有实际测量，但存在回退、未满足断言或完整性不足；NOT VERIFIED=未执行对应验证。文件存在、插件加载与页面能打开不作为目标功能 PASS。

## 实测环境及指标

真实 SillyTavern 1.18.0 8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8，使用 h675786161-prog/sillytavern-lab 指定版本；Edge 154.0.4258.62，1440×980 无头浏览器，独立数据目录。200/500/1000 楼，每楼 8 段长正文，角色消息含 reasoning、两份 swipe；世界背面套件通过原生 Generate 在归档前后实际重生成。三次交替开关性能对照，另外三次交替交互和刷新重入测试；两套时间来自不同运行阶段，不拼成一次操作轨迹。

加载、保存采用原生函数完成时间。swipe 为原生历史切换到两个动画帧，展开为原生 summary 点击到两个动画帧。刷新重入包含页面重载至 APP_READY 加显式重新打开该聊天，可能含酒馆自己的自动恢复；不是纯网络下载时间。DOM 表同时给聊天元素与整页所有节点（含文本、注释）；heap 无强制 GC，不能当作稳定内存收益。滚动为全历史 80 帧 scrollTop 压力扫描，不是物理滚轮 FPS；长任务阈值 50ms。

## 性能数据

时间单位 ms，heap MiB。PASS 表示该指标实际完成测量，不表示开启后更快。

| 楼数 | Echo | 采集状态 | 加载 | 聊天元素 / 整页所有节点 | JS heap | 跨楼滚动 P95 | swipe P95 | reasoning 首次 / 再次 | 保存 | 刷新重入 |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 200 | 关闭 | PASS | 802.9 | 17500 / 62603 | 41.9 | 4.5 | 662.2 | 49.5 / 15.2 | 142.1 | 2727.8 |
| 200 | 开启 | PASS | 717.1 | 17500 / 62603 | 54.6 | 10.2 | 544.7 | 25.1 / 10.6 | 148.0 | 2733.3 |
| 500 | 关闭 | PASS | 1657.6 | 43750 / 121553 | 64.1 | 6.6 | 1293.6 | 109.1 / 20.1 | 192.5 | 3868.2 |
| 500 | 开启 | PASS | 1710.1 | 43750 / 121553 | 70.9 | 13.5 | 986.2 | 32.0 / 17.2 | 195.6 | 3879.3 |
| 1000 | 关闭 | PASS | 3248.5 | 87500 / 219803 | 128.0 | 14.4 | 2612.2 | 211.4 / 43.2 | 311.0 | 5763.0 |
| 1000 | 开启 | PASS | 3407.0 | 87500 / 219803 | 251.9 | 28.4 | 2518.6 | 48.1 / 21.5 | 315.3 | 5910.4 |

完整 heap 使用后/刷新后变化、长任务数量及总时长见 evidence/acceptance-v2/summary.json。由于保留完整 DOM，不应宣称减少 DOM 数量或首次格式化成本。性能整体收益仍为 PARTIAL，保持默认关闭。

## 完整归档后的性能与旧楼交互

从真实自动流程保存的聊天复制测试分支；自动整理、自动隐藏和记忆注入保持开启，三次交替开关 Echo。每次使用相同归档源数据重新创建独立合成副本。下面测旧楼 11 的两个既有 swipe，避开被原生 regen 替换的最后一楼；同时测已隐藏旧楼的 reasoning、滚动压力扫描、真实鼠标滚轮及刷新重入。状态包括交互及隐藏标记检查，不能将 PARTIAL 行当作兼容 PASS。

| 楼数 | Echo | 状态 | 加载 | 聊天元素 / 整页所有节点 | JS heap | 跨楼滚动 P95 | 旧楼 swipe P95 | reasoning 首次 / 再次 | 保存 | 刷新重入 |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 200 | 关闭 | PASS | 951.8 | 17516 / 62642 | 61.9 | 5.1 | 918.7 | 81.3 / 12.2 | 178.6 | 4104.0 |
| 200 | 开启 | PASS | 936.0 | 17516 / 62642 | 59.0 | 15.6 | 748.4 | 27.7 / 11.6 | 157.4 | 4412.0 |
| 500 | 关闭 | PASS | 2109.6 | 43766 / 121592 | 145.9 | 11.7 | 1789.0 | 159.7 / 25.9 | 263.1 | 6835.0 |
| 500 | 开启 | PASS | 2358.8 | 43766 / 121592 | 145.6 | 22.9 | 1376.3 | 84.0 / 18.5 | 251.1 | 7159.0 |
| 1000 | 关闭 | PASS | 4557.1 | 87516 / 219842 | 343.0 | 34.4 | 4352.3 | 663.2 / 56.0 | 352.7 | 11492.0 |
| 1000 | 开启 | PASS | 5066.9 | 87516 / 219842 | 335.4 | 42.6 | 4035.9 | 58.5 / 34.5 | 349.0 | 11777.0 |

| 楼数 | Echo | 加载后 heap MiB | 操作后变化 MiB | 刷新后变化 MiB | 长任务数中位数 | 长任务总耗时 ms |
|---:|---|---:|---:|---:|---:|---:|
| 200 | 关闭 | 61.9 | -13.8 | 2.5 | 24 | 4133.0 |
| 200 | 开启 | 59.0 | 32.6 | 21.2 | 16 | 2671.0 |
| 500 | 关闭 | 145.9 | 6.0 | 24.0 | 64 | 12062.0 |
| 500 | 开启 | 145.6 | -7.6 | -14.2 | 45 | 8405.0 |
| 1000 | 关闭 | 343.0 | -49.2 | -190.3 | 54 | 27810.0 |
| 1000 | 开启 | 335.4 | -100.8 | -127.3 | 53 | 24940.0 |

内存变化相对于同一次测量的加载后值；未控制 GC，正负变化均不能直接证明优化节省内存。自动模型请求意外触发数：0。旧楼 swipe 正文检查：PASS；隐藏标记保留：PASS；真实滚轮移动与可见正文：PASS。原始逐次数据 archived-metrics.json。

刷新对照已确认 18 次重入后的实际 Echo 开关与该组配置一致：PASS。此前未持久保存开关的测量保存在 archived-metrics-refresh-unpaired.json，刷新指标为 NOT VERIFIED，不参与本表统计。

## reasoning profiling

真实 CDP CPU profiling 文件保存在 evidence/acceptance-v2/cpu-*.cpuprofile。仅测试浏览器对 ReasoningHandler.updateDom 加同步计时，生产代码不安装该计时器。采样间隔 500µs，采样是近似归因；updateDom 同步计时包含状态更新、格式化和 DOM 写入，不能全部当作 Markdown 格式化。CPU 列按采样祖先栈归因。

| 楼数 | Echo | 仪器加载 | reasoning UI 同步总耗时 | reasoning 内格式化 CPU | 全部格式化 CPU | 两次展开新增 UI 格式化调用 |
|---:|---|---:|---:|---:|---:|---|
| 200 | 关闭 | 742.8 | 33.7 | 24.8 | 176.8 | 0/0/0 |
| 200 | 开启 | 814.8 | 34.9 | 26.3 | 179.6 | 0/0/0 |
| 500 | 关闭 | 1766.5 | 83.3 | 65.9 | 408.7 | 0/0/0 |
| 500 | 开启 | 1824.2 | 84.0 | 64.8 | 424.7 | 0/0/0 |
| 1000 | 关闭 | 3767.6 | 187.5 | 152.0 | 897.9 | 0/0/0 |
| 1000 | 开启 | 3708.2 | 188.9 | 149.3 | 885.3 | 0/0/0 |

酒馆在 updateDom 中预先调用 messageFormatting 并写入 reasoning HTML；展开本身不等同于首次格式化。本轮不凭展开时间猜测瓶颈，不加全局 throttle，不修改 reasoning 历史或原生格式化。具体热点调用栈及同步调用次数见 summary.json。

## 世界背面自动流程

真实插件 commit f9babfa0ee0bd3003d3529fd171b83103cfee4c1。自动整理和自动隐藏均打开，memorySystemEnabled/injectionMemory 打开，初始整理间隔 10 轮，隐藏后的 regen 验收设为 1 轮。通过真实 MESSAGE_RECEIVED 和自动计时器触发；未直接写入索引、摘要或隐藏标记。真实本地 HTTP provider 返回可控 JSON，插件实际构造提示词、请求、解析、分批归档、分层压缩、保存并自动隐藏。没有以关闭目标功能作为兼容通过依据。

| 楼数 | Echo | 流程/数据检查 | 首次 / 后续索引至 | 首次 / 后续隐藏楼数 | 真实 HTTP 请求 | 全流程秒数 |
|---:|---|---|---:|---:|---:|---:|
| 200 | 关闭 | PARTIAL | 199 / 199 | 195 / 195 | 50 | 56.6 |
| 200 | 开启 | PARTIAL | 199 / 199 | 195 / 195 | 50 | 56.1 |
| 500 | 关闭 | PARTIAL | 499 / 499 | 495 / 495 | 116 | 129.6 |
| 500 | 开启 | PARTIAL | 499 / 499 | 495 / 495 | 116 | 119.6 |
| 1000 | 关闭 | PARTIAL | 908 / 999 | 904 / 995 | 245 | 344.9 |
| 1000 | 开启 | PARTIAL | 999 / 999 | 995 / 995 | 221 | 269.9 |

间隔 10 轮会保留不足阈值的尾部。本测试把间隔改为 1 并再次实际 regen，触发自动处理尾部；没有手动注入摘要。1000 楼关闭组第一次自动追平等待达到 240 秒上限时只索引至 908，后续流程才到 999，保留为 PARTIAL。计时包含归档、分层压缩、多次 regen 与生命周期检查，不能当作单个模型请求耗时。

原生 Generate('regenerate') 在此固定版本会删除并替换最后一楼，最后一楼从两份 swipe 变为一份；Echo 关闭/开启均观察到。最后一楼旧 swipe 全保留断言为 PARTIAL，不能据此宣称 Echo 导致丢失。其余历史保留另行按原始数组检查，并用上面的旧楼 11 测试有效 swipe 切换。

原流程曾对已被 regen 替换、只剩一份 swipe 的末楼尝试切换到不存在的第二份 swipe；原生 overswipe 因而再次生成，产生 Forbidden 页面错误及 CSRF 拒绝。这是测试操作错误，该末楼 swipe 探针为 NOT VERIFIED；保留原始失败记录，不能归因于 Echo 或世界背面。有效旧楼 swipe 已由上述 18 次补测覆盖。

另用实际完整归档源数据完成自动隐藏后的独立重生成补测，返回与旧正文不同的新回复，不再尝试越界 swipe。200/500/1000 楼各关闭/开启 Echo 共六组，整体 PASS：200/off=PASS，200/on=PASS，500/off=PASS，500/on=PASS，1000/off=PASS，1000/on=PASS。每组检查历史数组、隐藏标记、世界核心状态、原生新回复，以及真实自动请求确实读取新回复并提交新的 L0 摘要。模型为本地确定性 provider，外部模型语义仍 NOT VERIFIED。原始证据 posthide-clean-summary.json 及 posthide-clean-*.json。

独立刷新控制：Echo 全程关闭=true；聊天数组一致=true；世界状态重建差异=true。200 楼控制中 revision 6→5，摘要条目 5→218。这是观察到的结构重建，尚未证明完整语义等价；世界状态一致性继续 PARTIAL。没有修改世界背面代码。原始结果 world-refresh-control.json 与 world-differences.json。

PASS 仅表示具体流程和对应数据断言通过。**外部真实模型摘要质量：NOT VERIFIED**；模型依赖的完整语义兼容结论为 **PARTIAL**。这里只验证合成城市叙事，不能扩展到真实大型既有世界存档。隐藏是酒馆上下文排除标记，不等于删除历史或减少 DOM。

逐项检查覆盖摘要来源、隐藏范围、最近五楼、世界时间/人物/事件保留、归档后 swipe、隐藏 reasoning、归档前后 regen、启用→使用→禁用→刷新→再启用及数据回读。原始前后状态保存于 world-*.json。

未通过完整断言（PARTIAL）：
- 200/off: native regen retains length and original swipe history
- 200/off: swipe and archived reasoning after auto-hide: {"alternateCorrect":false,"restoredLastMessage":false,"archivedReasoningCorrect":true,"hiddenMarkerRetained":true,"initialSwipe":0}
- 200/off: refresh/re-enable preserves native data and world state
- 200/on: native regen retains length and original swipe history
- 200/on: swipe and archived reasoning after auto-hide: {"alternateCorrect":false,"restoredLastMessage":false,"archivedReasoningCorrect":true,"hiddenMarkerRetained":true,"initialSwipe":0}
- 200/on: refresh/re-enable preserves native data and world state
- 500/off: native regen retains length and original swipe history
- 500/off: swipe and archived reasoning after auto-hide: {"alternateCorrect":false,"restoredLastMessage":false,"archivedReasoningCorrect":true,"hiddenMarkerRetained":true,"initialSwipe":0}
- 500/off: refresh/re-enable preserves native data and world state
- 500/on: native regen retains length and original swipe history
- 500/on: swipe and archived reasoning after auto-hide: {"alternateCorrect":false,"restoredLastMessage":false,"archivedReasoningCorrect":true,"hiddenMarkerRetained":true,"initialSwipe":0}
- 500/on: refresh/re-enable preserves native data and world state
- 1000/off: native regen retains length and original swipe history
- 1000/off: swipe and archived reasoning after auto-hide: {"alternateCorrect":false,"restoredLastMessage":false,"archivedReasoningCorrect":true,"hiddenMarkerRetained":true,"initialSwipe":0}
- 1000/off: regen after hide preserves archived history and world core
- 1000/off: refresh/re-enable preserves native data and world state
- 1000/on: native regen retains length and original swipe history
- 1000/on: swipe and archived reasoning after auto-hide: {"alternateCorrect":false,"restoredLastMessage":false,"archivedReasoningCorrect":true,"hiddenMarkerRetained":true,"initialSwipe":0}
- 1000/on: refresh/re-enable preserves native data and world state

## 针对性修改

已复现并修复原生提示词 dryRun 预计算造成优化永久暂停的问题。GENERATION_STARTED(normal, {}, true) 没有匹配 ENDED，原实现错误设置 generating=true；现在忽略 dryRun，真实生成仍正常释放约束并在结束后恢复。证据 generation-diagnostic.json，修复后全档重复基准和实际 regen 流程。除此之外不扩大功能，不改保存节流。

页面异常：1。原始数据与状态标记优先于文字描述；未测项目一律 NOT VERIFIED。
