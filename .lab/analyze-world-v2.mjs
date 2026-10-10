import fs from 'node:fs/promises';
import path from 'node:path';
const out = path.resolve(import.meta.dirname, '../evidence/acceptance-v2');
function differences(a, b, prefix = '') {
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    if (a && b && typeof a === 'object' && typeof b === 'object') return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => differences(a[k], b[k], `${prefix}.${k}`));
    return [{ path: prefix, before: typeof a === 'string' ? a.slice(0, 160) : a, after: typeof b === 'string' ? b.slice(0, 160) : b }];
}
const rows = [];
for (const count of [200, 500, 1000]) for (const mode of ['off', 'on']) {
    let world; try { world = JSON.parse(await fs.readFile(path.join(out, `world-${count}-${mode}.json`), 'utf8')); } catch { continue; }
    const stateDiff = differences(world.postRegen.store.currentState, world.reloaded.store.currentState);
    const chatDiff = differences(world.postRegen.chat, world.reloaded.chat);
    rows.push({ count, mode, status: stateDiff.length || chatDiff.length ? 'PARTIAL' : 'PASS', nativeRegenerateLastSwipeCount: { before: world.before.chat.at(-1).swipes.length, after: world.regenerated.chat.at(-1).swipes.length }, stateDiffCount: stateDiff.length, stateDiff: stateDiff.slice(0, 40), chatDiffCount: chatDiff.length, chatDiff: chatDiff.slice(0, 20), initialIndexedThrough: world.after.store.currentState.storyMemory.indexedThroughMessageId, afterRegenIndexedThrough: world.postRegen.store.currentState.storyMemory.indexedThroughMessageId, reloadIndexedThrough: world.reloaded.store.currentState.storyMemory.indexedThroughMessageId });
}
await fs.writeFile(path.join(out, 'world-differences.json'), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows.map(r => ({ count: r.count, mode: r.mode, status: r.status, swipeCount: r.nativeRegenerateLastSwipeCount, stateDiffCount: r.stateDiffCount, statePaths: [...new Set(r.stateDiff.map(d => d.path.split('.').slice(0, 3).join('.')))], chatDiffCount: r.chatDiffCount, chatPaths: r.chatDiff.map(d => d.path), index: [r.initialIndexedThrough, r.afterRegenIndexedThrough, r.reloadIndexedThrough] })), null, 2));
