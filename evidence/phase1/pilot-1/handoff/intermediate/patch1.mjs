import { readFileSync, writeFileSync } from 'node:fs';
const p = '/output/mcp/adapter.js';
let s = readFileSync(p, 'utf8');
const reps = [
  [`    if (tr.samples.length < 2) continue;\n    var p0 = predict(tr, lead, g);`,
   `    if (tr.samples.length < 2) continue;\n    if (args.target_id != null && tr.id !== args.target_id) continue;\n    var p0 = predict(tr, lead, g);`],
  [`  if (!cand.length) return { ok: false, reason: 'no-fruits', fruits: fruitTracks.length };`,
   `  if (!cand.length) return { ok: false, reason: 'no-fruits', phase: readPhase(), fruits: fruitTracks.length };`],
  [`  if (!chain.length) return { ok: false, reason: 'no-chain', fruits: cand.length, bombs: bombs.length };`,
   `  if (!chain.length) return { ok: false, reason: 'no-chain', phase: readPhase(), fruits: cand.length, bombs: bombs.length };`],
  [`  return {\n    ok: true,\n    points: out,`,
   `  return {\n    ok: true,\n    phase: readPhase(),\n    points: out,`],
];
for (const [a, b] of reps) {
  if (!s.includes(a)) { console.error('MISS:', JSON.stringify(a.slice(0, 60))); process.exit(1); }
  s = s.replace(a, b);
}
writeFileSync(p, s);
console.log('patched');
