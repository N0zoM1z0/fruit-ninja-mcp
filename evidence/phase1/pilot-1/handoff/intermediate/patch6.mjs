import { readFileSync, writeFileSync } from 'node:fs';
const p = '/output/mcp/server.js';
let s = readFileSync(p, 'utf8');
const reps = [
  [`async function observe() {
  return adapter('observe', {});
}`,
   `async function observe() {
  return adapter('observe', {});
}

/* Serialize tool calls: the port executes one native input at a time and rejects
 * overlapping requests with BUSY, so never let two tools race. */
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}`],
  [`  async (args) => text(await stroke(args || {})),`,
   `  async (args) => text(await serialize(() => stroke(args || {}))),`],
  [`  async (args) => text(await stroke({ ...(args || {}), target_id: args.fruit_id, wait_ms: 0 })),`,
   `  async (args) => text(await serialize(() => stroke({ ...(args || {}), target_id: args.fruit_id, wait_ms: 0 }))),`],
  [`  async () => {
    const s = await observe();
    if (s.phase === 'playing') return text({ started: false, reason: 'already-playing', state: summarize(s) });
    if (!s.start_button) return text({ started: false, reason: 'no-start-button', state: summarize(s) });
    await sendClick(Math.round(s.start_button.x), Math.round(s.start_button.y));
    await sleep(150);
    const after = await observe();
    return text({ started: true, state: summarize(after) });
  },`,
   `  async () =>
    serialize(async () => {
      const s = await observe();
      if (s.phase === 'playing') return text({ started: false, reason: 'already-playing', state: summarize(s) });
      if (!s.start_button) return text({ started: false, reason: 'no-start-button', state: summarize(s) });
      await sendClick(Math.round(s.start_button.x), Math.round(s.start_button.y));
      await sleep(150);
      const after = await observe();
      return text({ started: true, state: summarize(after) });
    }),`],
  [`  async () => {
    const s = await observe();
    return text({`,
   `  async () =>
    serialize(async () => {
    const s = await observe();
    return text({`],
  [`      fruits: s.fruits,
      bombs: s.bombs,
      frame_age_ms: s.frame_age_ms,
    });
  },`,
   `      fruits: s.fruits,
      bombs: s.bombs,
      frame_age_ms: s.frame_age_ms,
    });
    }),`],
];
for (const [a, b] of reps) {
  if (!s.includes(a)) { console.error('MISS:', JSON.stringify(a.slice(0, 70))); process.exit(1); }
  s = s.replace(a, b);
}
writeFileSync(p, s);
console.log('patched');
