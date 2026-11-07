import { readFileSync, writeFileSync } from 'node:fs';
const p = '/output/mcp/adapter.js';
let s = readFileSync(p, 'utf8');
const a = `  return {
    ok: true,
    phase: readPhase(),
    points: out,`;
const b = `  return {
    ok: true,
    phase: readPhase(),
    now: now,
    t0: T0,
    raw: chain.map(function (c) { return { id: c.id, x: Math.round(c.x), y: Math.round(c.y), t: Math.round(c.t) }; }),
    points: out,`;
if (!s.includes(a)) { console.error('MISS'); process.exit(1); }
s = s.replace(a, b);
writeFileSync(p, s);
console.log('patched');
