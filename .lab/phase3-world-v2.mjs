import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-world-v2'));
await fs.mkdir(out, { recursive: true });
const entry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(entry).href);

const requests = [];
const provider = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let body=''; for await (const chunk of req) body += chunk;
    try {
        const data = JSON.parse(body);
        const text = (data.messages || []).map(x => x.content).join('\n');
        const ids = [...text.matchAll(/<message id="(\d+)" swipe="(\d+)" role="(user|assistant)">/g)].map(m => Number(m[1]));
        let payload;
        if (ids.length) payload = {
            memory_digest: { text:`Phase3 compatibility archive through ${ids.at(-1)}.`, through_message_id:ids.at(-1) },
            turn_summaries: ids.map(id => ({ id:`p3v2_${id}`, source_message_id:id, title:`Message ${id}`, summary:`Compatibility summary for message ${id}.`, people:[], locations:[], tags:[] })),
            facts_upsert:[], facts_invalidate:[], clues_upsert:[], clues_resolve:[], chapter_summary:null,
        };
        else if (text.includes('summary_rollup')) payload = { summary_rollup:{ title:'Phase3 compatibility stage', summary:'Archived fictional observations remain stable.', people:[], locations:[], tags:[] } };
        else throw new Error('Unsupported provider prompt');
        requests.push({ at:Date.now(), kind:ids.length?'history':'rollup', first:ids[0]??null, last:ids.at(-1)??null, count:ids.length });
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ choices:[{ message:{ role:'assistant', content:JSON.stringify(payload) }, finish_reason:'stop' }] }));
    } catch (e) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ error:String(e) })); }
});
await new Promise((resolve,reject)=>{ provider.once('error',reject); provider.listen(0,'127.0.0.1',resolve); });
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;

const browser = await chromium.launch({ executablePath:process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport:{ width:1440,height:980 } });
page.setDefaultTimeout(60000);
const pageErrors=[];
page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
await page.addLocatorHandler(page.locator('#wb-mama-note-modal'), async modal => modal.getByRole('button',{name:'收好纸条'}).click());

const ready = async () => {
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance && window.worldBackstageHost);
    await page.evaluate(async()=>{ const {power_user}=await import('/scripts/power-user.js'); power_user.chat_truncation=10000; for(const d of document.querySelectorAll('dialog[open]')) d.close(); });
};
const selectBench = () => page.evaluate(async()=>{ const s=await import('/script.js'); const id=s.characters.findIndex(c=>c.name==='Echo Bench'); if(id<0) throw new Error('Echo Bench missing'); await s.selectCharacterById(id); return id; });
const snapshot = () => page.evaluate(() => { const c=SillyTavern.getContext(); return { chat:structuredClone(c.chat), store:structuredClone(c.chatMetadata.world_backstage_v1||null), echo:EchoPerformance.stats(), live:document.querySelectorAll('#chat > .mes').length }; });
const core = store => { const s=store?.currentState||{}; return { clock:s.clock, people:s.people, events:s.events, locations:s.locations, publicImpactLedger:s.publicImpactLedger }; };
const normalizeReasoning = value => String(value ?? '').trim() || null;
const semantic = chat => chat.map(m => ({ mes:m?.mes, name:m?.name, is_user:m?.is_user, swipe_id:m?.swipe_id, swipes:m?.swipes, reasoning:normalizeReasoning(m?.extra?.reasoning ?? m?.reasoning) }));
const diffSemantic = (before, after, limit = 24) => {
    const rows=[];
    const length=Math.max(before.length, after.length);
    for(let i=0;i<length && rows.length<limit;i++) {
        const a=before[i]; const b=after[i];
        if(JSON.stringify(a)!==JSON.stringify(b)) rows.push({ index:i, before:a??null, after:b??null });
    }
    return { beforeLength:before.length, afterLength:after.length, mismatches:rows, truncated:rows.length===limit };
};
const indexed = () => page.evaluate(() => Number(SillyTavern.getContext().chatMetadata.world_backstage_v1?.currentState?.storyMemory?.indexedThroughMessageId ?? -1));
const hiddenCount = () => page.evaluate(() => SillyTavern.getContext().chat.filter(m=>m.extra?.world_backstage_auto_hidden).length);

const installRegenRoute = async text => page.route('**/api/backends/chat-completions/generate', async route => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({ choices:[{ message:{ role:'assistant', content:text, reasoning_content:'Phase3 compatibility native regen reasoning.' }, finish_reason:'stop' }] }) }));
const doRegen = () => page.evaluate(async()=>{ const s=await import('/script.js'); const {oai_settings}=await import('/scripts/openai.js'); s.changeMainAPI('openai'); oai_settings.chat_completion_source='custom'; oai_settings.custom_url='http://127.0.0.1:8041/v1'; oai_settings.custom_model='echo-world'; oai_settings.stream_openai=false; s.setOnlineStatus('echo-local'); await s.Generate('regenerate'); });

async function driveToCompletion(label) {
    const progress=[];
    let last=await indexed();
    let lastChange=Date.now();
    let wakeups=0;
    const started=Date.now();
    progress.push({ at:0, indexed:last, hidden:await hiddenCount(), action:'start' });
    while (Date.now()-started < 420000) {
        await page.waitForTimeout(1500);
        const now=await indexed();
        if (now!==last) {
            last=now; lastChange=Date.now();
            progress.push({ at:Date.now()-started, indexed:now, hidden:await hiddenCount(), action:'progress' });
        }
        if (now>=999) return { completed:true, wakeups, progress };
        if (now>=979) {
            await page.evaluate(() => worldBackstageHost.updatePublicOpinionSettings({ memoryAutoIndexInterval:1 }));
        }
        if (Date.now()-lastChange > 12000) {
            wakeups += 1;
            progress.push({ at:Date.now()-started, indexed:now, hidden:await hiddenCount(), action:'native-regenerate-wakeup', wakeups });
            await doRegen();
            lastChange=Date.now();
            if (wakeups>8) break;
        }
    }
    return { completed:(await indexed())>=999, wakeups, progress, finalIndexed:await indexed() };
}

const cases=[];
try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/'); await ready();
    for (const enabled of [false,true]) {
        const file=`echo-phase3-world-v2-${enabled?'on':'off'}`;
        await selectBench();
        await page.evaluate(async file => {
            const s=await import('/script.js'); const avatar=s.characters[s.this_chid].avatar;
            const r=await fetch('/api/chats/get',{method:'POST',headers:s.getRequestHeaders(),body:JSON.stringify({avatar_url:avatar,file_name:'echo-bench-1000'})});
            const rows=await r.json(); rows[0].chat_metadata={echo_phase3_world_v2:true};
            const sv=await fetch('/api/chats/save',{method:'POST',headers:s.getRequestHeaders(),body:JSON.stringify({avatar_url:avatar,file_name:file,chat:rows,force:true})});
            if(!sv.ok) throw new Error(`fixture save ${sv.status}`);
        }, file);
        await page.evaluate(async ({file,enabled,providerUrl}) => {
            const s=await import('/script.js'); await s.openCharacterChat(file); EchoPerformance.setEnabled(enabled,false);
            await worldBackstageHost.updatePublicOpinionSettings({ enabled:true, worldSimulationEnabled:false, worldAutoEnabled:false, autoSync:false, memorySystemEnabled:true, injectionMemory:true, memoryAutoIndexInterval:10, autoHideArchivedFloors:true, apiMode:'custom', customApiUrl:providerUrl, customApiKey:'echo-phase3-local-only', customApiModel:'echo-deterministic', customApiTransport:'direct', autoRetryCount:0 });
        }, {file,enabled,providerUrl});
        if(enabled) await page.waitForFunction(()=>EchoPerformance.stats().detachedMessageShells>=800,null,{timeout:30000});
        const before=await snapshot();
        const semanticBefore=semantic(before.chat.slice(0,-1));
        const coreBefore=core(before.store);
        const requestStart=requests.length;
        const regenText=`Phase3 World Backstage compatibility regenerated reply ${enabled?'ON':'OFF'}.`;
        await installRegenRoute(regenText);
        await doRegen();
        await page.waitForFunction(text=>SillyTavern.getContext().chat.at(-1)?.mes===text, regenText, {timeout:15000});
        const regenRead=await page.evaluate(text=>({ mes:SillyTavern.getContext().chat.at(-1)?.mes, ok:SillyTavern.getContext().chat.at(-1)?.mes===text }), regenText);
        const drive=await driveToCompletion(enabled?'ON':'OFF');
        await page.unroute('**/api/backends/chat-completions/generate');
        await page.waitForTimeout(1800);
        const after=await snapshot();
        const hidden=after.chat.flatMap((m,i)=>m.extra?.world_backstage_auto_hidden?[i]:[]);
        const archives=after.store?.memorySummaryArchive||[]; const summaries=after.store?.currentState?.storyMemory?.summaries||[];
        const covered=new Set([...archives,...summaries].filter(s=>s.level===0&&s.startMessageId===s.endMessageId&&s.summary).map(s=>s.endMessageId));
        const preRefresh={ core:core(after.store), hidden:[...hidden], indexed:after.store?.currentState?.storyMemory?.indexedThroughMessageId };
        const semanticAfter=semantic(after.chat.slice(0,-1));
        const semanticDiff=diffSemantic(semanticBefore,semanticAfter);
        await page.reload(); await ready(); await selectBench();
        await page.evaluate(async({file,enabled})=>{ const s=await import('/script.js'); await s.openCharacterChat(file); EchoPerformance.setEnabled(enabled,false); },{file,enabled});
        if(enabled) await page.waitForFunction(()=>EchoPerformance.stats().detachedMessageShells>=800,null,{timeout:30000});
        const refreshed=await snapshot();
        const refreshedHidden=refreshed.chat.flatMap((m,i)=>m.extra?.world_backstage_auto_hidden?[i]:[]);
        const checks={
            memoryCompleted:drive.completed && Number(after.store?.currentState?.storyMemory?.indexedThroughMessageId)>=999,
            automaticRequests:requests.slice(requestStart).some(x=>x.kind==='history'),
            nativeRegenReadable:regenRead.ok,
            hiddenPresent:hidden.length>0,
            hiddenCovered:hidden.length>0 && hidden.every(i=>covered.has(i)&&i<=994),
            semanticHistoryPreserved:semanticDiff.beforeLength===semanticDiff.afterLength && semanticDiff.mismatches.length===0,
            worldCoreNotAdvanced:JSON.stringify(coreBefore)===JSON.stringify(core(after.store)),
            refreshWorldCoreStable:JSON.stringify(preRefresh.core)===JSON.stringify(core(refreshed.store)),
            refreshHiddenStable:JSON.stringify(preRefresh.hidden)===JSON.stringify(refreshedHidden),
            refreshIndexedStable:preRefresh.indexed===refreshed.store?.currentState?.storyMemory?.indexedThroughMessageId,
            echoRecompactAfterRefresh:!enabled || (refreshed.echo.detachedMessageShells>=800 && refreshed.live<=180),
        };
        cases.push({ enabled, requestCount:requests.length-requestStart, drive, hiddenCount:hidden.length, indexedThrough:after.store?.currentState?.storyMemory?.indexedThroughMessageId, refreshedIndexedThrough:refreshed.store?.currentState?.storyMemory?.indexedThroughMessageId, semanticDiff, checks });
        await fs.writeFile(path.join(out,'world-v2.json'),JSON.stringify({cases,pageErrors,requests},null,2));
        console.log(JSON.stringify({enabled,indexed:cases.at(-1).indexedThrough,hidden:hidden.length,wakeups:drive.wakeups,semanticDiff,checks}));
    }
    const all=cases.every(c=>Object.values(c.checks).every(Boolean));
    const off=cases.find(c=>!c.enabled), on=cases.find(c=>c.enabled);
    const comparison=off&&on?Object.fromEntries(Object.keys(on.checks).map(k=>[k,{off:off.checks[k],on:on.checks[k]}])):null;
    const summary={status:all?'PASS':'PARTIAL',cases,comparison,pageErrors};
    await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
    console.log(JSON.stringify({status:summary.status,comparison,pageErrors:pageErrors.length},null,2));
    if(!all) process.exitCode=2;
} finally { provider.close(); await browser.close(); }