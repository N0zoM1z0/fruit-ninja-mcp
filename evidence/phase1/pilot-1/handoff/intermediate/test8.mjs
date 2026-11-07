import { GamePortClient } from '/opt/toolchain/fn/port-client.js';
const c = new GamePortClient(process.env.FN_GAME_PORT || '/work/port.sock');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const A = async (fn, args) => { const r = await c.adapter(fn, args); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

const LEAD = Number(process.argv[2] || 45);
const STEP = Number(process.argv[3] || 40);

const st0 = await A('observe', {});
if (st0.phase === 'menu') await c.click(Math.round(st0.start_button.x), Math.round(st0.start_button.y));
await sleep(1200);

let lastRtt = 40;
let hits = 0, targets = 0, strokes = 0, zero = 0;
for (let i = 0; i < 30; i++) {
  let plan = null;
  for (let k = 0; k < 40; k++) {
    const t0 = Date.now();
    plan = await A('plan', { lead_ms: LEAD, step_ms: STEP });
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
  strokes++; targets += plan.targets.length; hits += gained;
  if (gained === 0) zero++;
  console.log(`#${i} dur=${plan.duration_ms} targets=${plan.targets.length} gained=${gained} score=${after.score} actual=${res.previous_action && res.previous_action.actual_duration_ms}`);
}
console.log(`LEAD=${LEAD} STEP=${STEP} strokes=${strokes} zero=${zero} targets=${targets} gained=${hits} eff=${(hits / Math.max(1, targets)).toFixed(2)}`);
