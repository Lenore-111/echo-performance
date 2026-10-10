import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-observer-compare'));
await fs.mkdir(out, { recursive: true });
const entry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(entry).href);
const browser = await chromium.launch({ executablePath:process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
const rows=[];

const observerOnly = list => list.filter(e => /MutationObserver|parameter 1 is not of type 'Node'|Failed to execute 'observe'/i.test(`${e.message}\n${e.stack}`));

try {
    for (const enabled of [false,true]) {
        for (let repeat=0; repeat<3; repeat++) {
            const page=await browser.newPage({viewport:{width:1440,height:980}});
            page.setDefaultTimeout(60000);
            const errors=[];
            page.on('pageerror',e=>errors.push({message:String(e),stack:String(e?.stack||e)}));
            await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/');
            await page.waitForFunction(()=>window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready')&&window.EchoPerformance);
            await page.evaluate(async enabled=>{
                const {power_user}=await import('/scripts/power-user.js'); power_user.chat_truncation=10000;
                for(const d of document.querySelectorAll('dialog[open]')) d.close();
                const s=await import('/script.js'); const chid=s.characters.findIndex(c=>c.name==='Echo Bench');
                if(chid<0) throw new Error('Echo Bench missing');
                await s.selectCharacterById(chid); EchoPerformance.setEnabled(enabled,false); await s.openCharacterChat('echo-bench-1000'); EchoPerformance.setEnabled(enabled,false);
            },enabled);
            if(enabled) await page.waitForFunction(()=>EchoPerformance.stats().detachedMessageShells>=800,null,{timeout:30000});
            const input=page.locator('#send_textarea');
            await input.click();
            await input.fill('/chat-jump 809');
            await page.waitForTimeout(100);
            await input.press('Enter');
            await page.waitForTimeout(1200);
            const observerErrors=observerOnly(errors);
            rows.push({enabled,repeat,observerErrors,allErrors:errors,bridge:await page.evaluate(()=>EchoPerformance.stats().bridge)});
            await page.close();
        }
    }
    const off=rows.filter(r=>!r.enabled).flatMap(r=>r.observerErrors);
    const on=rows.filter(r=>r.enabled).flatMap(r=>r.observerErrors);
    const stackKey=e=>String(e.stack||e.message).replace(/http:\/\/127\.0\.0\.1:\d+/g,'HOST');
    const offStacks=new Set(off.map(stackKey));
    const echoExclusive=on.filter(e=>!offStacks.has(stackKey(e)));
    const result={ rows, offCount:off.length, onCount:on.length, echoExclusiveCount:echoExclusive.length, echoExclusive, classification:echoExclusive.length===0 && off.length>0 ? 'NATIVE_ST_BASELINE' : echoExclusive.length ? 'ECHO_EXCLUSIVE' : 'NO_ERROR_REPRODUCED' };
    await fs.writeFile(path.join(out,'observer-compare.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({offCount:result.offCount,onCount:result.onCount,echoExclusiveCount:result.echoExclusiveCount,classification:result.classification},null,2));
    if(result.echoExclusiveCount>0) process.exitCode=2;
} finally { await browser.close(); }
