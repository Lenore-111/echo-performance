import fs from 'node:fs/promises';
const dir = new URL('../evidence/acceptance-v2/', import.meta.url);
const workflow = JSON.parse(await fs.readFile(new URL('workflow-summary.json', dir), 'utf8'));
for (const count of [200, 500, 1000]) for (const mode of ['off', 'on']) {
    const file = new URL(`world-${count}-${mode}.json`, dir);
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.automaticWorkflowCompletionStatus ??= data.status;
    data.status = workflow.checks.filter(c => c.name.startsWith(`${count}/${mode}:`)).every(c => c.status === 'PASS') ? 'PASS' : 'PARTIAL';
    data.invalidLastSwipeProbeStatus = 'NOT VERIFIED';
    data.labelExplanation = 'Overall compatibility includes refresh state reconstruction; original last-floor out-of-range swipe was an invalid test. Observations retained unchanged. See clean post-hide and historical message 11 supplements.';
    await fs.writeFile(file, JSON.stringify(data, null, 2));
}
const oldFile = new URL('archived-metrics-refresh-unpaired.json', dir);
const old = JSON.parse(await fs.readFile(oldFile, 'utf8'));
old.status = 'PARTIAL';
for (const row of old.rows) {
    row.originalInteractionStatus ??= row.status;
    row.status = 'PARTIAL';
    row.refreshVerificationStatus = 'NOT VERIFIED';
}
await fs.writeFile(oldFile, JSON.stringify(old, null, 2));
