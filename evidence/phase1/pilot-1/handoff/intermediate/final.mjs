import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'agent', version: '1' });
await client.connect(new StdioClientTransport({ command: '/work/mcp/launch.sh', args: [], env: process.env, stderr: 'inherit' }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content && r.content[0] && r.content[0].text;
  try { return JSON.parse(txt); } catch { return txt; }
};
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2), ...a);

// edge cases first
log('slice before start ->', JSON.stringify(await call('slice', {})));
log('state ->', JSON.stringify(await call('game_state')).slice(0, 200));
log('start ->', JSON.stringify(await call('start_round', {})));
log('start again ->', JSON.stringify(await call('start_round', {})));
const st = await call('game_state');
if (st.fruits && st.fruits.length) {
  log('slice_fruit ->', JSON.stringify(await call('slice_fruit', { fruit_id: st.fruits[0].id })));
}
let total = 0;
for (let i = 0; i < 200; i++) {
  const r = await call('slice', {});
  if (!r.sliced) { log('stop', JSON.stringify(r)); break; }
  total += r.gained;
  if (i % 10 === 0) log(`slice ${i + 1} gained=${r.gained} score=${r.score_after} rem=${r.state.remaining}`);
  if (r.state.phase !== 'playing') { log('phase', r.state.phase); break; }
}
log('TOTAL', total);
log('final', JSON.stringify(await call('game_state')).slice(0, 300));
await client.close();
