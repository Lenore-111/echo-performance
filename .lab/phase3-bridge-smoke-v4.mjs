import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root=path.resolve(import.meta.dirname,'..');
const out=path.resolve(process.env.LAB_EVIDENCE_DIR||path.join(root,'evidence/phase3-bridge-smoke-v4'));
await fs.mkdir(out,{recursive:true});
const entry=process.env.LAB_PLAYWRIGHT_CORE_ENTRY||path.resolve(root,'../qa-tools/node_modules/playwright-core/index.mjs');
const {chromium}=await import(entry.startsWith('file:')?entry:pathToFileURL(entry).href);
const browser=await chromium.launch({executablePath:process.env.LAB_CHROME||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--enable-precise-memory-info','--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:980}});
page.setDefaultTimeout(60000);
const errors=[]; page.on('pageerror',e=>errors.push({message:String(e),stack:String(e?.stack||e)}));
const target=809; const state={target};
const save=()=>fs.writeFile(path.join(out,'bridge-smoke-v4.json'),JSON.stringify({state,errors},null,2));
const norm=v=>String(v??'').replace(/\s+/g,' ').trim();

const duplicates=()=>page.evaluate(()=>{const seen=new Set(),dup=[];for(const n of document.querySelectorAll('#chat > .mes')){const id=n.getAttribute('mesid');if(seen.has(id))dup.push(id);else seen.add(id);}return [...new Set(dup)];});
const viewport=id=>page.evaluate(id=>{const root=document.querySelector('#chat');const matches=[...root.querySelectorAll(`:scope > .mes[mesid="${id}"]`)];const n=matches[0];const rr=root.getBoundingClientRect();const nr=n?.getBoundingClientRect?.();return{count:matches.length,unique:matches.length===1,visible:Boolean(nr&&nr.bottom>rr.top&&nr.top<rr.bottom),scrollTop:root.scrollTop,scrollHeight:root.scrollHeight,nodeTop:nr?.top??null,nodeBottom:nr?.bottom??null,rootTop:rr.top,rootBottom:rr.bottom};},id);

async function releaseAndRecompact(id){
    // Native /chat-jump uses smooth scrolling. Let that settle before deliberately
    // leaving the historical area, otherwise its animation can pull us back.
    await page.waitForTimeout(900);
    await page.evaluate(()=>{
        const input=document.querySelector('#send_textarea'); input?.focus({preventScroll:true});
        const chat=document.querySelector('#chat');
        chat.scrollTo({top:chat.scrollHeight,behavior:'auto'}); chat.dispatchEvent(new Event('scroll'));
        requestAnimationFrame(()=>requestAnimationFrame(()=>{chat.scrollTo({top:chat.scrollHeight,behavior:'auto'});chat.dispatchEvent(new Event('scroll'));}));
    });
    await page.waitForFunction(id=>!document.querySelector(`#chat > .mes[mesid="${id}"]`),id,{timeout:12000});
    return true;
}

async function nativeSlash(text){
    const input=page.locator('#send_textarea'); await input.click(); await input.fill(text); await page.waitForTimeout(100); await input.press('Enter'); await page.waitForTimeout(1100);
}

try{
    await page.goto(process.env.LAB_ST_URL||'http://127.0.0.1:8039/');
    await page.waitForFunction(()=>window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready')&&window.EchoPerformance);
    await page.evaluate(async()=>{const {power_user}=await import('/scripts/power-user.js');power_user.chat_truncation=10000;for(const d of document.querySelectorAll('dialog[open]'))d.close();const s=await import('/script.js');const chid=s.characters.findIndex(c=>c.name==='Echo Bench');if(chid<0)throw new Error('Echo Bench missing');await s.selectCharacterById(chid);EchoPerformance.setEnabled(false,false);await s.openCharacterChat('echo-bench-1000');EchoPerformance.setEnabled(false,false);});
    state.eligibility=await page.evaluate(id=>import('/script.js').then(s=>({swipeable:s.isMessageSwipeable(id,s.chat[id]),overswipeBehavior:s.getOverswipeBehavior(id,s.chat[id]),lastId:s.chat.length-1})),target);
    await page.evaluate(id=>{const shell=document.querySelector(`#chat > .mes[mesid="${id}"]`);window.p3refs={shell,edit:shell?.querySelector('.mes_edit')};},target);
    await page.evaluate(()=>EchoPerformance.setEnabled(true,false));
    await page.waitForFunction(()=>EchoPerformance.stats().detachedMessageShells>=800&&EchoPerformance.stats().liveMessageShells<=180,null,{timeout:30000});
    state.initial=await page.evaluate(id=>({live:Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`)),stats:EchoPerformance.stats()}),target);

    state.edit=await page.evaluate(async id=>{const beforeLive=Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));window.p3refs.edit?.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const shell=document.querySelector(`#chat > .mes[mesid="${id}"]`);const ta=shell?.querySelector('.edit_textarea');let saved=false;if(ta instanceof HTMLTextAreaElement){ta.value+=' [P3B-V4]';ta.dispatchEvent(new Event('input',{bubbles:true}));shell.querySelector('.mes_edit_done')?.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));saved=SillyTavern.getContext().chat[id]?.mes?.includes('[P3B-V4]')===true&&shell.querySelector('.mes_text')?.textContent?.includes('[P3B-V4]')===true;window.p3refs.reasoning=shell.querySelector('.mes_reasoning_header')||shell.querySelector('.mes_reasoning_header_title');}return{beforeLive,mountedAfter:shell instanceof HTMLElement,editorOpened:ta instanceof HTMLTextAreaElement,saved,bridge:EchoPerformance.stats().bridge};},target);
    state.edit.duplicates=await duplicates(); state.edit.recompacted=await releaseAndRecompact(target); await save();

    state.reasoning=await page.evaluate(async id=>{const beforeLive=Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));window.p3refs.reasoning?.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const shell=document.querySelector(`#chat > .mes[mesid="${id}"]`);const details=shell?.querySelector('details');return{beforeLive,mountedAfter:shell instanceof HTMLElement,open:details instanceof HTMLDetailsElement?details.open:null,contentLength:shell?.querySelector('.mes_reasoning')?.textContent?.length??0,bridge:EchoPerformance.stats().bridge};},target);
    state.reasoning.duplicates=await duplicates(); state.reasoning.recompacted=await releaseAndRecompact(target); await save();

    state.swipe=await page.evaluate(async id=>{const c=SillyTavern.getContext();const {SWIPE_DIRECTION,SWIPE_SOURCE}=await import('/scripts/constants.js');const beforeLive=Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));const before=Number(c.chat[id].swipe_id??0);const desired=before===0?1:0;let thrown=null;try{await c.swipe.to(null,desired>before?SWIPE_DIRECTION.RIGHT:SWIPE_DIRECTION.LEFT,{source:SWIPE_SOURCE.SWIPE_PICKER,repeated:false,forceMesId:id,forceSwipeId:desired,forceDuration:0});}catch(e){thrown=String(e?.stack||e);}await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const shell=document.querySelector(`#chat > .mes[mesid="${id}"]`);return{beforeLive,mountedAfter:shell instanceof HTMLElement,before,desired,after:c.chat[id]?.swipe_id,stateChanged:c.chat[id]?.swipe_id===desired,domText:shell?.querySelector('.mes_text')?.textContent||'',chatText:c.chat[id]?.mes||'',swipeText:c.chat[id]?.swipes?.[c.chat[id]?.swipe_id]||'',thrown,bridge:EchoPerformance.stats().bridge};},target);
    state.swipe.domMatches=norm(state.swipe.domText).includes(norm(state.swipe.chatText).slice(0,80))||norm(state.swipe.domText).includes(norm(state.swipe.swipeText).slice(0,80));
    state.swipe.duplicates=await duplicates(); state.swipe.recompacted=await releaseAndRecompact(target); await save();

    state.jumpBeforeLive=await page.evaluate(id=>Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`)),target); await nativeSlash(`/chat-jump ${target}`);
    state.jump={viewport:await viewport(target),duplicates:await duplicates(),bridge:await page.evaluate(()=>EchoPerformance.stats().bridge)}; state.jump.recompacted=await releaseAndRecompact(target); await save();

    state.scrollToBeforeLive=await page.evaluate(id=>Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`)),target); await nativeSlash(`/chat-scrollto ${target}`);
    state.scrollTo={viewport:await viewport(target),duplicates:await duplicates(),bridge:await page.evaluate(()=>EchoPerformance.stats().bridge)}; state.scrollTo.recompacted=await releaseAndRecompact(target); await save();

    state.more=await page.evaluate(async()=>{const s=await import('/script.js');const before=EchoPerformance.stats();await s.showMoreMessages(50);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return{before,after:EchoPerformance.stats()};}); state.more.duplicates=await duplicates();

    await page.evaluate(()=>{const c=document.querySelector('#chat');document.querySelector('#send_textarea')?.focus({preventScroll:true});c.scrollTo({top:c.scrollHeight,behavior:'auto'});});
    const box=await page.locator('#chat').boundingBox(); await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.evaluate(()=>{window.p3frames=[];window.p3active=true;let last=performance.now();const tick=now=>{if(!window.p3active)return;window.p3frames.push(now-last);last=now;requestAnimationFrame(tick);};requestAnimationFrame(tick);});
    for(let i=0;i<35;i++){await page.mouse.wheel(0,-900);await page.waitForTimeout(24);}for(let i=0;i<35;i++){await page.mouse.wheel(0,900);await page.waitForTimeout(24);}await page.waitForTimeout(400);
    state.scroll=await page.evaluate(()=>{window.p3active=false;const frames=[...window.p3frames].sort((a,b)=>a-b);const samples=EchoPerformance.stats().restoreSamples||[];return{p95Ms:frames.length?frames[Math.floor((frames.length-1)*.95)]:null,dropped33:frames.filter(x=>x>33.4).length,driftMaxPx:samples.length?Math.max(...samples.map(x=>Math.abs(x.driftPx||0))):null,restoreMaxMs:samples.length?Math.max(...samples.map(x=>x.durationMs||0)):null};});
    state.regen=await page.evaluate(id=>import('/script.js').then(s=>({historicalSwipeable:s.isMessageSwipeable(id,s.chat[id]),overswipeBehavior:s.getOverswipeBehavior(id,s.chat[id]),currentTarget:s.chat.length-1,currentMounted:Boolean(document.querySelector(`#chat > .mes[mesid="${s.chat.length-1}"]`))})),target);
    state.final=await page.evaluate(()=>({stats:EchoPerformance.stats(),live:document.querySelectorAll('#chat > .mes').length}));state.final.duplicates=await duplicates();
    state.observerErrors=errors.filter(e=>/MutationObserver|parameter 1 is not of type 'Node'|Failed to execute 'observe'/i.test(`${e.message}\n${e.stack}`));
    state.gates={
      core:state.initial.stats.liveMessageShells<=180&&state.initial.stats.detachedMessageShells>=800,
      edit:!state.edit.beforeLive&&state.edit.mountedAfter&&state.edit.editorOpened&&state.edit.saved&&state.edit.recompacted&&state.edit.duplicates.length===0,
      reasoning:!state.reasoning.beforeLive&&state.reasoning.mountedAfter&&state.reasoning.open===true&&state.reasoning.contentLength>0&&state.reasoning.recompacted&&state.reasoning.duplicates.length===0,
      swipe:!state.swipe.beforeLive&&state.swipe.mountedAfter&&state.swipe.stateChanged&&state.swipe.domMatches&&!state.swipe.thrown&&state.swipe.recompacted&&state.swipe.duplicates.length===0,
      jump:!state.jumpBeforeLive&&state.jump.viewport.unique&&state.jump.viewport.visible&&state.jump.duplicates.length===0&&state.jump.bridge.inputPreMounts>0&&state.jump.recompacted,
      scrollTo:!state.scrollToBeforeLive&&state.scrollTo.viewport.unique&&state.scrollTo.viewport.visible&&state.scrollTo.duplicates.length===0&&state.scrollTo.recompacted,
      reconciliation:state.more.duplicates.length===0&&state.more.after.nativeReconciliations>=state.more.before.nativeReconciliations,
      scroll:(state.scroll.p95Ms??Infinity)<50&&(state.scroll.driftMaxPx??Infinity)<=8,
      regenInvariant:state.regen.historicalSwipeable||state.regen.currentMounted,
      duplicates:state.final.duplicates.length===0
    };
    state.verdict=Object.values(state.gates).every(Boolean)?'PASS':'FAIL'; await save();
    console.log(JSON.stringify({verdict:state.verdict,gates:state.gates,bridge:state.final.stats.bridge,observerErrors:state.observerErrors.length,swipe:{beforeLive:state.swipe.beforeLive,after:state.swipe.after,domMatches:state.swipe.domMatches},jump:state.jump.viewport,scrollTo:state.scrollTo.viewport},null,2));
    if(state.verdict!=='PASS')process.exitCode=2;
}catch(e){state.harnessError=String(e?.stack||e);await save();console.error(state.harnessError);process.exitCode=3;}finally{await browser.close();}
