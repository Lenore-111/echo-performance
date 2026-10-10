# Reasoning、swipe 和保存开销评估

基于实验环境固定的 SillyTavern 1.18.0 commit `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`，直接读取真实运行代码并执行浏览器回归。

## 已确认的现状

- `printMessages()` 已支持 `power_user.chat_truncation`，只显示最近若干楼，并提供继续加载入口。两轮基准将它设为 10000，确保对应档位完整渲染；第二轮为 200/500/1000 楼。Echo 不修改用户的截断设置。
- `redisplayChat()` 对每一楼运行 `updateMessageElement()`，原生正文格式化、reasoning 初始化等仍发生于首次渲染。Echo 的浏览器按需布局不会绕过这些步骤。
- `ReasoningHandler.updateDom()` 对历史 reasoning 执行正文格式化并写入 DOM，即使 reasoning details 当前折叠。第二轮真实 CPU profiling 与同步计时显示，在这批 1000 楼合成聊天中，reasoning UI 更新约占仪器加载的 5%，点击展开没有新增该 UI 格式化调用。具体 CPU 归因见 `acceptance-v2.md`；不能把“折叠时仍格式化”直接当作主要瓶颈，当前不修改 reasoning 格式化。
- 需要同时保留 reasoning 的复制、编辑、展开、翻译和流式生成行为；现有展开处理会阻止空 reasoning 区域打开，不能通过“把它先清空”直接替代原生逻辑。当前扩展不做 reasoning 拦截。
- 每条消息只显示当前 `mes` 文本，没有把所有历史 `swipes` 同时渲染成消息正文。因此“删除旧 swipe DOM”不能带来预想收益。swipe 历史会增加完整聊天保存体积，应保留它，不能以性能为由删除。
- `saveChatDebounced()` 已按 1000ms 延后保存，并检查角色和群聊身份。`saveChatConditional()` 已等待保存锁，取消待执行的延后任务并串行保存。聊天切换和操作完成等场景仍有即时保存要求。
- 保存时会对完整聊天、metadata 和 swipes 进行 JSON 序列化及请求压缩，随后保存 token/prompt 缓存。基准单独记录了序列化时长、请求负载字节数及端到端保存时长。

## 本次决策

不再套一层全局保存节流，也不替换 `fetch`、原生保存函数或事件发射器。第二层节流会改变插件 `await saveChat()` 的完成含义，引入切换聊天时未保存、重生成时错配版本、覆盖世界背面 metadata 等风险；当前实测不能证明值得承担这些变化。

以下仅为未来有新 profiling 证据时的技术边界，本轮不实现，也不据此扩大功能：

1. 对折叠 reasoning 采用有状态的惰性格式化，保证展开、复制、编辑和流式状态切换一致。
2. 在原生保存队列中合并重复请求，显式定义 flush、聊天身份和快照归属，并验证断线、切换和插件等待语义。
3. 采用原生消息虚拟化生命周期和插件兼容接口，再评估真正的 DOM 节点移出；当前扩展保留完整 DOM。

这些是代码和实測支持的评估结果，不是已经实现或已经验证的优化。
