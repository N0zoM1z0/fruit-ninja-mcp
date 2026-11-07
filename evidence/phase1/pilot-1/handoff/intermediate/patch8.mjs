import { readFileSync, writeFileSync } from 'node:fs';
const p = '/output/mcp/adapter.js';
let s = readFileSync(p, 'utf8');

// 1) finalizePath: never scale times down (that would break the speed cap); drop
//    trailing points instead.
const a = `  for (i = 1; i < out.length; i++) {
    var a = out[i - 1], b = out[i];
    var d = Math.hypot(b.x - a.x, b.y - a.y);
    var need = Math.ceil(d / 4800 * 1000);
    if (b.t_ms - a.t_ms < need) b.t_ms = a.t_ms + Math.max(1, need);
  }
  var total = out[out.length - 1].t_ms;
  if (total > 1000) {
    var sc = 1000 / total;
    for (i = 0; i < out.length; i++) out[i].t_ms = Math.round(out[i].t_ms * sc);
    for (i = 1; i < out.length; i++) if (out[i].t_ms <= out[i - 1].t_ms) out[i].t_ms = out[i - 1].t_ms + 1;
  }
  return out;`;
const b = `  for (;;) {
    for (i = 1; i < out.length; i++) {
      var a = out[i - 1], b = out[i];
      var d = Math.hypot(b.x - a.x, b.y - a.y);
      var need = Math.ceil(d / 4800 * 1000);
      if (b.t_ms - a.t_ms < need) b.t_ms = a.t_ms + Math.max(1, need);
    }
    if (out[out.length - 1].t_ms <= 1000 || out.length <= 2) break;
    out.pop();   // scaling down would break the speed cap, so shed the tail instead
  }
  return out;`;
if (!s.includes(a)) { console.error('MISS finalize'); process.exit(1); }
s = s.replace(a, b);

// 2) single-target strokes should follow the fruit's own trajectory, not a fixed
//    horizontal nudge.
const c = `  var pts = [];
  for (i = 0; i < chain.length; i++) pts.push({ x: chain[i].x, y: chain[i].y, t_ms: chain[i].t - T0 });
  if (pts.length === 1) pts.push({ x: pts[0].x + 46, y: pts[0].y, t_ms: 46 });`;
const d = `  var pts = [];
  for (i = 0; i < chain.length; i++) pts.push({ x: chain[i].x, y: chain[i].y, t_ms: chain[i].t - T0 });
  if (pts.length === 1) {
    var onlyTr = null;
    for (i = 0; i < cand.length; i++) if (cand[i].tr.id === chain[0].id) onlyTr = cand[i].tr;
    var p2 = onlyTr ? predictAt(onlyTr, T0 + step, g) : { x: pts[0].x + 46, y: pts[0].y };
    if (Math.hypot(p2.x - pts[0].x, p2.y - pts[0].y) < 6) p2 = { x: pts[0].x + 46, y: pts[0].y };
    pts.push({ x: p2.x, y: p2.y, t_ms: step });
  }`;
if (!s.includes(c)) { console.error('MISS single'); process.exit(1); }
s = s.replace(c, d);

writeFileSync(p, s);
console.log('patched');
