import http from 'node:http';
export async function startProvider() {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        let body = ''; for await (const chunk of req) body += chunk;
        try {
            const data = JSON.parse(body), text = data.messages.map(m => m.content).join('\n');
            const messages = [...text.matchAll(/<message id="(\d+)" swipe="(\d+)" role="(user|assistant)">([\s\S]*?)<\/message>/g)].map(m => ({ id: Number(m[1]), swipe: Number(m[2]), text: m[4] }));
            let payload;
            if (messages.length) payload = { memory_digest: { text: `Echo fixture archive through ${messages.at(-1).id}.`, through_message_id: messages.at(-1).id }, turn_summaries: messages.map(m => ({ id: `echo_l0_${m.id}`, source_message_id: m.id, title: `Message ${m.id}`, summary: m.text.includes('Verified post-hide regeneration') ? m.text.slice(0, 180) : `The fictional traveller recorded message ${m.id}.`, people: [], locations: [], tags: [] })), facts_upsert: [], facts_invalidate: [], clues_upsert: [], clues_resolve: [], chapter_summary: null };
            else if (text.includes('summary_rollup')) payload = { summary_rollup: { title: 'Echo stage', summary: 'The fictional traveller preserved the previously archived observations.', people: [], locations: [], tags: [] } };
            else throw new Error('Unsupported test-provider prompt');
            requests.push({ kind: messages.length ? 'history' : 'rollup', ids: messages.map(m => m.id), regeneratedTextPresent: messages.some(m => m.text.includes('Verified post-hide regeneration')), at: Date.now() });
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }] }));
        } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { server, url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise(r => server.close(r)) };
}
