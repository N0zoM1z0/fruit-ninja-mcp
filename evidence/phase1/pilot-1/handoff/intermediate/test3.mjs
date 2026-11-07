import { GamePortClient } from '/opt/toolchain/fn/port-client.js';
const c = new GamePortClient(process.env.FN_GAME_PORT || '/work/port.sock');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const A = async (fn, args) => { const r = await c.adapter(fn, args); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

const st0 = await A('observe', {});
if (st0.phase === 'menu') await c.click(Math.round(st0.start_button.x), Math.round(st0.start_button.y));
await sleep(1200);

let lastRtt = 40;
for (let i = 0; i < 25; i++) {
  let plan = null;
  for (let k = 0; k < 40; k++) {
    const t0 = Date.now();
    plan = await A('plan', { lead_ms: Math.round(lastRtt / 2 + 25) });
    lastRtt = Date.now() - t0;
    if (plan.ok || plan.reason !== 'no-fruits') break;
    await sleep(50);
  }
  if (!plan.ok) { console.log('plan fail', plan.reason); continue; }
  const before = await A('observe', {});
  const res = await c.path(plan.points);
  await sleep(80);
  const after = await A('observe', {});
  const gained = after.score - before.score;
  console.log(`#${i} dur=${plan.duration_ms} targets=${plan.targets.length} gained=${gained} score=${after.score}`);
  if (gained === 0) {
    console.log('  POINTS', JSON.stringify(plan.points));
    console.log('  BEFORE', JSON.stringify(before.fruits.map(f => [f.id, Math.round(f.x), Math.round(f.y), Math.round(f.r), Math.round(f.vx), Math.round(f.vy)])));
    console.log('  AFTER ', JSON.stringify(after.fruits.map(f => [f.id, Math.round(f.x), Math.round(f.y)])));
    console.log('  BOMBS ', JSON.stringify(before.bombs.map(f => [Math.round(f.x), Math.round(f.y), Math.round(f.r)])));
    console.log('  res', JSON.stringify(res));
  }
}
