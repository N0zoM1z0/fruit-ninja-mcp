import { readFileSync, writeFileSync } from 'node:fs';
const p = '/output/mcp/adapter.js';
let s = readFileSync(p, 'utf8');
const reps = [
  // processFrame: propagate the fitted velocity to the newest sample time
  [`function processFrame(f) {
  fruitTracks = matchTracks(fruitTracks, f.fruits, 170, f.t);
  bombTracks = matchTracks(bombTracks, f.bombs, 170, f.t);
  var g = canvasInfo().H * 1.03;
  var i, v;
  for (i = 0; i < fruitTracks.length; i++) { v = fitVel(fruitTracks[i].samples, g); fruitTracks[i].vx = v.vx; fruitTracks[i].vy = v.vy; }
  for (i = 0; i < bombTracks.length; i++) { v = fitVel(bombTracks[i].samples, g); bombTracks[i].vx = v.vx; bombTracks[i].vy = v.vy; }
}`,
   `function processFrame(f) {
  fruitTracks = matchTracks(fruitTracks, f.fruits, 170, f.t);
  bombTracks = matchTracks(bombTracks, f.bombs, 170, f.t);
  var g = canvasInfo().H * 1.03;
  var i, v, sm, span;
  for (i = 0; i < fruitTracks.length; i++) {
    sm = fruitTracks[i].samples;
    v = fitVel(sm, g);
    span = (sm[sm.length - 1].t - sm[0].t) / 1000;
    fruitTracks[i].vx = v.vx;
    fruitTracks[i].vy = v.vy + g * span;   // fitVel reports the velocity at the OLDEST sample
  }
  for (i = 0; i < bombTracks.length; i++) {
    sm = bombTracks[i].samples;
    v = fitVel(sm, g);
    span = (sm[sm.length - 1].t - sm[0].t) / 1000;
    bombTracks[i].vx = v.vx;
    bombTracks[i].vy = v.vy + g * span;
  }
}`],
  // predict: absolute target time, referenced to the track's own sample time
  [`/** Position of a track dtMs milliseconds from now (dtMs may be negative). */
function predict(tr, dtMs, g) {
  var dt = dtMs / 1000;
  return { x: tr.x + tr.vx * dt, y: tr.y + tr.vy * dt + 0.5 * g * dt * dt };
}`,
   `/** Position of a track at absolute page time tAbs (ms), from its newest sample. */
function predictAt(tr, tAbs, g) {
  var dt = (tAbs - tr.t) / 1000;
  return { x: tr.x + tr.vx * dt, y: tr.y + tr.vy * dt + 0.5 * g * dt * dt };
}`],
];
for (const [a, b] of reps) {
  if (!s.includes(a)) { console.error('MISS:', JSON.stringify(a.slice(0, 70))); process.exit(1); }
  s = s.replace(a, b);
}
// rewrite the remaining predict() call sites to predictAt with absolute times
s = s.replace(/predict\(tr, lead, g\)/g, 'predictAt(tr, T0, g)');
s = s.replace(/predict\(bm\.tr, t - now, g\)/g, 'predictAt(bm.tr, t, g)');
s = s.replace(/predict\(f\.tr, Math\.max\(0, curT - now\), g\)/g, 'predictAt(f.tr, Math.max(curT, T0), g)');
s = s.replace(/predict\(best\.tr, t - now, g\)/g, 'predictAt(best.tr, t, g)');
writeFileSync(p, s);
console.log('patched');
