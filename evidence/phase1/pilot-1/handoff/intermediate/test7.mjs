import { GamePortClient } from '/opt/toolchain/fn/port-client.js';
const c = new GamePortClient(process.env.FN_GAME_PORT || '/work/port.sock');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const A = async (fn, args) => { const r = await c.adapter(fn, args); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

const st0 = await A('observe', {});
if (st0.phase === 'menu') await c.click(Math.round(st0.start_button.x), Math.round(st0.start_button.y));
await sleep(1200);

let lastRtt = 40;
for (let i = 0; i < 20; i++) {
  let plan = null;
  for (let k = 0; k < 40; k++) {
    const t0 = Date.now();
    plan = await A('plan', { lead_ms: Math.round(lastRtt / 2 + 25) });
    lastRtt = Date.now() - t0;
    if (plan.ok || plan.reason !== 'no-fruits') break;
    await sleep(50);
  }
  if (!plan.ok) { console.log('plan fail', plan.reason); continue; }
  await A('clearEvents', {});
  const before = await A('observe', {});
  const res = await c.path(plan.points);
  await sleep(80);
  const after = await A('observe', {});
  const gained = after.score - before.score;
  console.log(`#${i} dur=${plan.duration_ms} targets=${plan.targets.length} gained=${gained} score=${after.score}`);
  if (gained < plan.targets.length) {
    const ev = await A('events', { n: 400 });
    const dbg = await A('debug', { n: 30 });
    console.log('  POINTS', JSON.stringify(plan.points.map(p => [Math.round(p.x), Math.round(p.y), p.t_ms])));
    console.log('  BEFORE', JSON.stringify(before.fruits.map(f => [f.id, Math.round(f.x), Math.round(f.y), Math.round(f.r), Math.round(f.vx), Math.round(f.vy), f.age_ms])));
    console.log('  EVENTS', JSON.stringify(ev.map(e => [e.t.slice(0, 9), Math.round(e.x), Math.round(e.y), e.ts])));
    console.log('  FRAMES');
    for (const f of dbg.frames) console.log('   ', f.t, JSON.stringify(f.fruits));
    break;
  }
}
