import { readFileSync, writeFileSync } from 'node:fs';
const p = '/output/mcp/server.js';
let s = readFileSync(p, 'utf8');
const a = `async function stroke(opts) {
  const before = await observe();
  if (before.phase !== 'playing') {
    return { sliced: false, reason: 'round-not-playing', state: summarize(before) };
  }`;
const b = `async function stroke(opts) {
  let before = await observe();
  if (before.phase === 'menu' && before.start_button) {
    // Safety net: the round has not been started yet, so spend this call's single
    // native input on the start button instead of on a stroke.
    await sendClick(Math.round(before.start_button.x), Math.round(before.start_button.y));
    await sleep(150);
    before = await observe();
    return {
      sliced: false,
      reason: 'round-started',
      note: 'The round was not running, so the start button was clicked. Call slice again to strike.',
      state: summarize(before),
    };
  }
  if (before.phase !== 'playing') {
    return { sliced: false, reason: 'round-not-playing', state: summarize(before) };
  }`;
if (!s.includes(a)) { console.error('MISS'); process.exit(1); }
s = s.replace(a, b);
writeFileSync(p, s);
console.log('patched');
