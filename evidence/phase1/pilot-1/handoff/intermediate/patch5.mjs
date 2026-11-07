import { readFileSync, writeFileSync } from 'node:fs';
const p = '/output/mcp/adapter.js';
let s = readFileSync(p, 'utf8');
const reps = [
  [`  var margin = args.bomb_margin == null ? 26 : Number(args.bomb_margin);
  var T0 = now + lead;`,
   `  var margin = args.bomb_margin == null ? 26 : Number(args.bomb_margin);
  // The native executor emits roughly one mouse sample per CDP round trip, so a
  // segment shorter than that round trip is stretched in wall time.  Keeping every
  // segment at least step_ms long keeps the blade on the planned schedule.
  var step = clamp(args.step_ms == null ? 40 : Number(args.step_ms), 8, 200);
  var T0 = now + lead;`],
  [`      t = curT;
      for (var it = 0; it < 5; it++) {
        var q = predictAt(best.tr, t, g);
        t = curT + Math.hypot(q.x - curP.x, q.y - curP.y) / speed * 1000;
      }
    }`,
   `      t = curT + step;
      for (var it = 0; it < 5; it++) {
        var q = predictAt(best.tr, t, g);
        t = curT + Math.max(step, Math.hypot(q.x - curP.x, q.y - curP.y) / speed * 1000);
      }
    }`],
  [`    duration_ms: out[out.length - 1].t_ms,
    lead_ms: Math.round(lead),`,
   `    duration_ms: out[out.length - 1].t_ms,
    lead_ms: Math.round(lead),
    step_ms: Math.round(step),`],
];
for (const [a, b] of reps) {
  if (!s.includes(a)) { console.error('MISS:', JSON.stringify(a.slice(0, 70))); process.exit(1); }
  s = s.replace(a, b);
}
writeFileSync(p, s);
console.log('patched');
