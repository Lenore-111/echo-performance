import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [], inventory = [];
const secretPatterns = [ /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/g, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, /\bBearer\s+[A-Za-z0-9_.=-]{20,}/gi, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi ];
function visit(value, file, location = '') {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
        const here = `${location}/${key}`;
        if (/^(?:api[_-]?key|customApiKey|cookie|cookies|authorization|access[_-]?token|refresh[_-]?token|password|email|username|account)$/i.test(key) && item && item !== 'echo-local-fixture-only') findings.push({ file, location: here, kind: 'nonempty-credential-or-account-field' });
        if (typeof item === 'object') visit(item, file, here);
    }
}
for (const file of files) {
    const data = await fs.readFile(file);
    inventory.push({ path: file, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
    if (/\.(png|zip)$/.test(file)) continue;
    const text = data.toString('utf8');
    for (const pattern of secretPatterns) { pattern.lastIndex = 0; if (pattern.test(text)) findings.push({ file, kind: 'credential-or-email-pattern' }); }
    if (/\.(json|cpuprofile)$/.test(file)) visit(JSON.parse(text), file);
}
const report = { scope: 'Git index file inventory; JSON credential fields and common secret/email signatures; screenshots require visual review.', syntheticFixtureKey: 'echo-local-fixture-only is a non-authenticating local test literal', findings, inventory };
await fs.writeFile('evidence/upload-audit.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ files: files.length, bytes: inventory.reduce((s, x) => s + x.bytes, 0), findings }, null, 2));
if (findings.length) process.exitCode = 1;
