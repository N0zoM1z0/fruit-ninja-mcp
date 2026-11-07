import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'agent', version: '1' });
await client.connect(new StdioClientTransport({ command: '/work/mcp/launch.sh', args: [], env: process.env, stderr: 'inherit' }));

const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2), ...a);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content && r.content[0] && r.content[0].text;
  try { return JSON.parse(txt); } catch { return txt; }
};

log('state', JSON.stringify(await call('game_state')));
log('start', JSON.stringify(await call('start_round')));
let total = 0;
for (let i = 0; i < 45; i++) {
  const r = await call('slice', {});
  if (!r.sliced) { log('stop', JSON.stringify(r)); break; }
  total += r.gained;
  log(`slice ${i + 1} targets=${r.targets} dur=${r.duration_ms} gained=${r.gained} score=${r.score_after} fruits=${r.state.fruits} bombs=${r.state.bombs} rem=${r.state.remaining}`);
  if (r.state.phase !== 'playing') { log('phase', r.state.phase); break; }
}
log('TOTAL', total);
log('final', JSON.stringify(await call('game_state')));
await client.close();
