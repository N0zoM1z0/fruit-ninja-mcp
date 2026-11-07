import { GamePortClient } from '/opt/toolchain/fn/port-client.js';
const c = new GamePortClient(process.env.FN_GAME_PORT || '/work/port.sock');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const A = async (fn, args) => { const r = await c.adapter(fn, args); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

const st0 = await A('observe', {});
if (st0.phase === 'menu') await c.click(Math.round(st0.start_button.x), Math.round(st0.start_button.y));
await sleep(1200);

// calibrate: measure actual vs planned duration for a given step
for (const step of [10, 20, 30, 40, 60, 80]) {
  let plan = null;
  for (let k = 0; k < 40; k++) {
    plan = await A('plan', { lead_ms: 45, step_ms: step });
    if (plan.ok || plan.reason !== 'no-fruits') break;
    await sleep(50);
  }
  if (!plan.ok) { console.log('step', step, 'plan fail', plan.reason); continue; }
  const res = await c.path(plan.points);
  const act = res.previous_action && res.previous_action.actual_duration_ms;
  const segs = plan.points.length - 1;
  console.log(`step=${step} pts=${plan.points.length} segs=${segs} planned=${plan.duration_ms} actual=${act} diff=${act - plan.duration_ms} perSeg=${((act - plan.duration_ms) / segs).toFixed(1)}`);
  await sleep(120);
}
