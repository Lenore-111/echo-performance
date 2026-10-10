import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'evidence/acceptance-v2');
const read = async file => JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
const paired = await read('paired.json');
const interaction = await read('interactions.json');
const workflow = await read('workflow-summary.json');
const archived = await read('archived-metrics.json');
const refreshControl = await read('world-refresh-control.json');
const posthide = await read('posthide-clean-summary.json');
const q = (values, fraction = .5) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
const stats = [], profileStats = [], worldStats = [], archivedStats = [];
for (const count of [200, 500, 1000]) for (const enabled of [false, true]) {
    const rows = paired.results.filter(x => x.count === count && (x.mode === 'optimized') === enabled);
    const extra = interaction.metrics.filter(x => x.count === count && x.enabled === enabled);
    const sampleCount = rows.length === 3 && extra.length === 3;
    const memoryDeltas = { interactionHeapInitialMiB: q(extra.map(x => x.heapUsed / 1048576)), interactionHeapDeltaMiB: q(extra.map(x => (x.heapAfterInteractions - x.heapUsed) / 1048576)), reloadHeapDeltaMiB: q(extra.map(x => (x.heapAfterReload - x.heapUsed) / 1048576)) };
    stats.push({ count, enabled, status: sampleCount ? 'PASS' : 'PARTIAL', loadMs: q(rows.map(x => x.loadMs)), domElements: q(rows.map(x => x.domNodes)), chatElements: q(rows.map(x => x.chatNodes)), totalDomNodes: q(extra.map(x => x.domNodes)), heapMiB: q(rows.map(x => x.heapUsed / 1048576)), heapAfterInteractionsMiB: q(extra.map(x => x.heapAfterInteractions / 1048576)), heapAfterReloadMiB: q(extra.map(x => x.heapAfterReload / 1048576)), scrollP95Ms: q(rows.flatMap(x => x.scroll.frames), .95), longTasks: q(rows.map(x => x.longTasks.length)), longTaskTotalMs: q(rows.map(x => x.longTasks.reduce((a, b) => a + b.duration, 0))), swipeP95Ms: q(extra.flatMap(x => x.swipeMs), .95), reasoningFirstMs: q(extra.map(x => x.reasoningExpansion[0].ms)), reasoningRepeatMs: q(extra.map(x => x.reasoningExpansion[1].ms)), saveMs: q(rows.flatMap(x => x.save.samples)), refreshAndEnterMs: q(extra.map(x => x.reloadAndEnterMs)) });
    for (const row of extra) {
        const profile = await read(`cpu-${count}-${enabled ? 'on' : 'off'}-${row.repeat}.cpuprofile`);
        const nodes = new Map(profile.nodes.map(n => [n.id, n])); const parent = new Map();
        for (const n of profile.nodes) for (const child of n.children || []) parent.set(child, n.id);
        const buckets = { reasoningUpdateDomMs: 0, reasoningFormattingMs: 0, allMessageFormattingMs: 0, gcMs: 0 };
        const self = new Map();
        for (let i = 0; i < (profile.samples || []).length; i++) {
            const sample = profile.samples[i], ms = (profile.timeDeltas?.[i] || 0) / 1000;
            const stack = []; for (let id = sample; id; id = parent.get(id)) { const n = nodes.get(id); if (n) stack.push(n.callFrame); }
            const reasoning = stack.some(f => f.url.endsWith('/scripts/reasoning.js') && f.functionName === 'updateDom');
            const formatting = stack.some(f => f.functionName === 'messageFormatting');
            if (reasoning) buckets.reasoningUpdateDomMs += ms;
            if (reasoning && formatting) buckets.reasoningFormattingMs += ms;
            if (formatting) buckets.allMessageFormattingMs += ms;
            if (stack.some(f => f.functionName === '(garbage collector)')) buckets.gcMs += ms;
            const frame = nodes.get(sample)?.callFrame; const name = `${frame?.functionName || '(anonymous)'} @ ${frame?.url || 'native'}:${(frame?.lineNumber ?? -1) + 1}`;
            self.set(name, (self.get(name) || 0) + ms);
        }
        profileStats.push({ count, enabled, repeat: row.repeat, status: 'PASS', profiledLoadMs: row.profiledLoadMs, synchronousReasoningUiMs: row.reasoningProfile.reduce((n, x) => n + x.ms, 0), reasoningUiCalls: row.reasoningProfile.length, reasoningUiChars: row.reasoningProfile.reduce((n, x) => n + x.chars, 0), formattingCallsOnExpand: row.formattingCallsOnExpand, ...buckets, hottestSelfFrames: [...self].sort((a, b) => b[1] - a[1]).slice(0, 12) });
    }
    const world = await read(`world-${count}-${enabled ? 'on' : 'off'}.json`);
    const caseChecks = workflow.checks.filter(c => c.name.startsWith(`${count}/${enabled ? 'on' : 'off'}:`));
    Object.assign(stats.at(-1), memoryDeltas);
    worldStats.push({ count, enabled, status: world.status === 'PASS' && caseChecks.every(c => c.status === 'PASS') ? 'PASS' : 'PARTIAL', indexedThrough: world.indexedThrough, finalIndexedThrough: world.postRegen.store.currentState.storyMemory.indexedThroughMessageId, hiddenFloors: world.hiddenIds.length, finalHiddenFloors: world.postRegen.chat.filter(m => m.extra?.world_backstage_auto_hidden).length, workflowError: world.workflowError, httpRequests: world.requestCount, elapsedMs: world.elapsedMs, checks: caseChecks, externalModelSummaryQuality: 'NOT VERIFIED' });
    const ar = archived.rows.filter(x => x.count === count && x.enabled === enabled);
    archivedStats.push({ count, enabled, status: ar.length === 3 && ar.every(x => x.status === 'PASS') ? 'PASS' : 'PARTIAL', repeats: ar.length, loadMs: q(ar.map(x => x.loadMs)), totalDomNodes: q(ar.map(x => x.domNodes)), chatElements: q(ar.map(x => x.chatElements)), heapMiB: q(ar.map(x => x.heapBefore / 1048576)), heapDeltaMiB: q(ar.map(x => (x.heapAfter - x.heapBefore) / 1048576)), heapReloadDeltaMiB: q(ar.map(x => (x.heapAfterReload - x.heapBefore) / 1048576)), scrollP95Ms: q(ar.flatMap(x => x.scrollMs), .95), swipeP95Ms: q(ar.flatMap(x => x.swipeMs), .95), reasoningFirstMs: q(ar.map(x => x.reasoningMs[0].ms)), reasoningRepeatMs: q(ar.map(x => x.reasoningMs[1].ms)), saveMs: q(ar.map(x => x.saveMs)), refreshAndEnterMs: q(ar.map(x => x.refreshAndEnterMs)), longTasks: q(ar.map(x => x.longTasks.length)), longTaskTotalMs: q(ar.map(x => x.longTasks.reduce((n, e) => n + e.duration, 0))), allHiddenMarkersRetained: ar.every(x => x.hiddenMarkerRetainedAfterSwipe), swipeTextCorrect: ar.every(x => x.swipeCorrect), wheelMovedAndVisibleBodiesPresent: ar.every(x => x.wheelAfter < x.wheelBefore && x.visibleBodiesPresent) });
}
const summary = { status: 'PARTIAL', date: '2026-10-10', reason: 'Performance tradeoffs and world-state reconstruction remain; deterministic provider verifies automatic workflow, not external model summary quality.', runtimeCommit: paired.runtimeCommit, browser: paired.browser, stats, profileStats, worldStats, archivedStats, refreshControl, posthide, archivedRefreshModeVerified: archived.rows.length === 18 && archived.rows.every(r => r.echoEnabledAfterReload === r.enabled), errors: [...paired.errors, ...interaction.errors, ...workflow.errors, ...archived.errors, ...refreshControl.errors, ...posthide.errors], checks: [...interaction.checks, ...workflow.checks] };
await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
const f = x => Number(x).toFixed(1);
const lines = stats.map(s => `| ${s.count} | ${s.enabled ? '开启' : '关闭'} | ${s.status} | ${f(s.loadMs)} | ${s.chatElements} / ${s.totalDomNodes} | ${f(s.heapMiB)} | ${f(s.scrollP95Ms)} | ${f(s.swipeP95Ms)} | ${f(s.reasoningFirstMs)} / ${f(s.reasoningRepeatMs)} | ${f(s.saveMs)} | ${f(s.refreshAndEnterMs)} |`).join('\n');
const worlds = worldStats.map(w => `| ${w.count} | ${w.enabled ? '开启' : '关闭'} | ${w.status} | ${w.indexedThrough} / ${w.finalIndexedThrough} | ${w.hiddenFloors} / ${w.finalHiddenFloors} | ${w.httpRequests} | ${f(w.elapsedMs / 1000)} |`).join('\n');
const archiveLines = archivedStats.map(s => `| ${s.count} | ${s.enabled ? '开启' : '关闭'} | ${s.status} | ${f(s.loadMs)} | ${s.chatElements} / ${s.totalDomNodes} | ${f(s.heapMiB)} | ${f(s.scrollP95Ms)} | ${f(s.swipeP95Ms)} | ${f(s.reasoningFirstMs)} / ${f(s.reasoningRepeatMs)} | ${f(s.saveMs)} | ${f(s.refreshAndEnterMs)} |`).join('\n');
const memoryLines = archivedStats.map(s => `| ${s.count} | ${s.enabled ? '开启' : '关闭'} | ${f(s.heapMiB)} | ${f(s.heapDeltaMiB)} | ${f(s.heapReloadDeltaMiB)} | ${s.longTasks} | ${f(s.longTaskTotalMs)} |`).join('\n');
const profiling = [200, 500, 1000].flatMap(count => [false, true].map(enabled => {
    const rows = profileStats.filter(s => s.count === count && s.enabled === enabled);
    return `| ${count} | ${enabled ? '开启' : '关闭'} | ${f(q(rows.map(x => x.profiledLoadMs)))} | ${f(q(rows.map(x => x.synchronousReasoningUiMs)))} | ${f(q(rows.map(x => x.reasoningFormattingMs)))} | ${f(q(rows.map(x => x.allMessageFormattingMs)))} | ${rows.map(x => x.formattingCallsOnExpand).join('/')} |`;
})).join('\n');
const failures = workflow.checks.filter(c => c.status !== 'PASS');
await fs.writeFile(path.join(root, 'docs/acceptance-v2.md'), `# Echo Performance 长聊天真实性能验收第二轮

整体状态：**PARTIAL**。开发分支 feature/echo-performance-long-chat。没有正式 release，没有推送远端。

报告日期：2026-10-10（Asia/Shanghai）；测试跨 2026-10-09 夜间及 10 日。PASS=具体指标完成采集或明确行为断言通过；PARTIAL=有实际测量，但存在回退、未满足断言或完整性不足；NOT VERIFIED=未执行对应验证。文件存在、插件加载与页面能打开不作为目标功能 PASS。

## 实测环境及指标

真实 SillyTavern 1.18.0 ${paired.runtimeCommit}，使用 h675786161-prog/sillytavern-lab 指定版本；Edge ${paired.browser}，1440×980 无头浏览器，独立数据目录。200/500/1000 楼，每楼 8 段长正文，角色消息含 reasoning、两份 swipe；世界背面套件通过原生 Generate 在归档前后实际重生成。三次交替开关性能对照，另外三次交替交互和刷新重入测试；两套时间来自不同运行阶段，不拼成一次操作轨迹。

加载、保存采用原生函数完成时间。swipe 为原生历史切换到两个动画帧，展开为原生 summary 点击到两个动画帧。刷新重入包含页面重载至 APP_READY 加显式重新打开该聊天，可能含酒馆自己的自动恢复；不是纯网络下载时间。DOM 表同时给聊天元素与整页所有节点（含文本、注释）；heap 无强制 GC，不能当作稳定内存收益。滚动为全历史 80 帧 scrollTop 压力扫描，不是物理滚轮 FPS；长任务阈值 50ms。

## 性能数据

时间单位 ms，heap MiB。PASS 表示该指标实际完成测量，不表示开启后更快。

| 楼数 | Echo | 采集状态 | 加载 | 聊天元素 / 整页所有节点 | JS heap | 跨楼滚动 P95 | swipe P95 | reasoning 首次 / 再次 | 保存 | 刷新重入 |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${lines}

完整 heap 使用后/刷新后变化、长任务数量及总时长见 evidence/acceptance-v2/summary.json。由于保留完整 DOM，不应宣称减少 DOM 数量或首次格式化成本。性能整体收益仍为 PARTIAL，保持默认关闭。

## 完整归档后的性能与旧楼交互

从真实自动流程保存的聊天复制测试分支；自动整理、自动隐藏和记忆注入保持开启，三次交替开关 Echo。每次使用相同归档源数据重新创建独立合成副本。下面测旧楼 11 的两个既有 swipe，避开被原生 regen 替换的最后一楼；同时测已隐藏旧楼的 reasoning、滚动压力扫描、真实鼠标滚轮及刷新重入。状态包括交互及隐藏标记检查，不能将 PARTIAL 行当作兼容 PASS。

| 楼数 | Echo | 状态 | 加载 | 聊天元素 / 整页所有节点 | JS heap | 跨楼滚动 P95 | 旧楼 swipe P95 | reasoning 首次 / 再次 | 保存 | 刷新重入 |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${archiveLines}

| 楼数 | Echo | 加载后 heap MiB | 操作后变化 MiB | 刷新后变化 MiB | 长任务数中位数 | 长任务总耗时 ms |
|---:|---|---:|---:|---:|---:|---:|
${memoryLines}

内存变化相对于同一次测量的加载后值；未控制 GC，正负变化均不能直接证明优化节省内存。自动模型请求意外触发数：${archived.unexpectedModelRequests.length}。旧楼 swipe 正文检查：${archivedStats.every(x => x.swipeTextCorrect) ? 'PASS' : 'PARTIAL'}；隐藏标记保留：${archivedStats.every(x => x.allHiddenMarkersRetained) ? 'PASS' : 'PARTIAL'}；真实滚轮移动与可见正文：${archivedStats.every(x => x.wheelMovedAndVisibleBodiesPresent) ? 'PASS' : 'PARTIAL'}。原始逐次数据 archived-metrics.json。

刷新对照已确认 18 次重入后的实际 Echo 开关与该组配置一致：${summary.archivedRefreshModeVerified ? 'PASS' : 'PARTIAL'}。此前未持久保存开关的测量保存在 archived-metrics-refresh-unpaired.json，刷新指标为 NOT VERIFIED，不参与本表统计。

## reasoning profiling

真实 CDP CPU profiling 文件保存在 evidence/acceptance-v2/cpu-*.cpuprofile。仅测试浏览器对 ReasoningHandler.updateDom 加同步计时，生产代码不安装该计时器。采样间隔 500µs，采样是近似归因；updateDom 同步计时包含状态更新、格式化和 DOM 写入，不能全部当作 Markdown 格式化。CPU 列按采样祖先栈归因。

| 楼数 | Echo | 仪器加载 | reasoning UI 同步总耗时 | reasoning 内格式化 CPU | 全部格式化 CPU | 两次展开新增 UI 格式化调用 |
|---:|---|---:|---:|---:|---:|---|
${profiling}

酒馆在 updateDom 中预先调用 messageFormatting 并写入 reasoning HTML；展开本身不等同于首次格式化。本轮不凭展开时间猜测瓶颈，不加全局 throttle，不修改 reasoning 历史或原生格式化。具体热点调用栈及同步调用次数见 summary.json。

## 世界背面自动流程

真实插件 commit f9babfa0ee0bd3003d3529fd171b83103cfee4c1。自动整理和自动隐藏均打开，memorySystemEnabled/injectionMemory 打开，初始整理间隔 10 轮，隐藏后的 regen 验收设为 1 轮。通过真实 MESSAGE_RECEIVED 和自动计时器触发；未直接写入索引、摘要或隐藏标记。真实本地 HTTP provider 返回可控 JSON，插件实际构造提示词、请求、解析、分批归档、分层压缩、保存并自动隐藏。没有以关闭目标功能作为兼容通过依据。

| 楼数 | Echo | 流程/数据检查 | 首次 / 后续索引至 | 首次 / 后续隐藏楼数 | 真实 HTTP 请求 | 全流程秒数 |
|---:|---|---|---:|---:|---:|---:|
${worlds}

间隔 10 轮会保留不足阈值的尾部。本测试把间隔改为 1 并再次实际 regen，触发自动处理尾部；没有手动注入摘要。1000 楼关闭组第一次自动追平等待达到 240 秒上限时只索引至 908，后续流程才到 999，保留为 PARTIAL。计时包含归档、分层压缩、多次 regen 与生命周期检查，不能当作单个模型请求耗时。

原生 Generate('regenerate') 在此固定版本会删除并替换最后一楼，最后一楼从两份 swipe 变为一份；Echo 关闭/开启均观察到。最后一楼旧 swipe 全保留断言为 PARTIAL，不能据此宣称 Echo 导致丢失。其余历史保留另行按原始数组检查，并用上面的旧楼 11 测试有效 swipe 切换。

原流程曾对已被 regen 替换、只剩一份 swipe 的末楼尝试切换到不存在的第二份 swipe；原生 overswipe 因而再次生成，产生 Forbidden 页面错误及 CSRF 拒绝。这是测试操作错误，该末楼 swipe 探针为 NOT VERIFIED；保留原始失败记录，不能归因于 Echo 或世界背面。有效旧楼 swipe 已由上述 18 次补测覆盖。

另用实际完整归档源数据完成自动隐藏后的独立重生成补测，返回与旧正文不同的新回复，不再尝试越界 swipe。200/500/1000 楼各关闭/开启 Echo 共六组，整体 ${posthide.status}：${posthide.rows.map(r => r.count + '/' + (r.enabled ? 'on' : 'off') + '=' + r.status).join('，')}。每组检查历史数组、隐藏标记、世界核心状态、原生新回复，以及真实自动请求确实读取新回复并提交新的 L0 摘要。模型为本地确定性 provider，外部模型语义仍 NOT VERIFIED。原始证据 posthide-clean-summary.json 及 posthide-clean-*.json。

独立刷新控制：Echo 全程关闭=${refreshControl.echoDisabledForEntireControl}；聊天数组一致=${refreshControl.nativeChatUnchanged}；世界状态重建差异=${refreshControl.stateReconstructionDiffWithEchoDisabled}。200 楼控制中 revision ${refreshControl.stateCounts.seedRevision}→${refreshControl.stateCounts.openRevision}，摘要条目 ${refreshControl.stateCounts.seedSummaries}→${refreshControl.stateCounts.openSummaries}。这是观察到的结构重建，尚未证明完整语义等价；世界状态一致性继续 PARTIAL。没有修改世界背面代码。原始结果 world-refresh-control.json 与 world-differences.json。

PASS 仅表示具体流程和对应数据断言通过。**外部真实模型摘要质量：NOT VERIFIED**；模型依赖的完整语义兼容结论为 **PARTIAL**。这里只验证合成城市叙事，不能扩展到真实大型既有世界存档。隐藏是酒馆上下文排除标记，不等于删除历史或减少 DOM。

逐项检查覆盖摘要来源、隐藏范围、最近五楼、世界时间/人物/事件保留、归档后 swipe、隐藏 reasoning、归档前后 regen、启用→使用→禁用→刷新→再启用及数据回读。原始前后状态保存于 world-*.json。

${failures.length ? '未通过完整断言（PARTIAL）：\n' + failures.map(c => '- ' + c.name + (c.detail ? ': ' + JSON.stringify(c.detail) : '')).join('\n') : '上述列出的逐项断言全部 PASS。'}

## 针对性修改

已复现并修复原生提示词 dryRun 预计算造成优化永久暂停的问题。GENERATION_STARTED(normal, {}, true) 没有匹配 ENDED，原实现错误设置 generating=true；现在忽略 dryRun，真实生成仍正常释放约束并在结束后恢复。证据 generation-diagnostic.json，修复后全档重复基准和实际 regen 流程。除此之外不扩大功能，不改保存节流。

页面异常：${summary.errors.length}。原始数据与状态标记优先于文字描述；未测项目一律 NOT VERIFIED。
`);
console.log(JSON.stringify({ status: summary.status, metrics: stats, worlds: worldStats.map(({ checks, ...s }) => s), failures, errors: summary.errors }, null, 2));
