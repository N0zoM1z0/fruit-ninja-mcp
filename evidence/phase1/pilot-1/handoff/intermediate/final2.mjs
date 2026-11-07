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

// never call start_round: slice must bootstrap the round by itself
log('slice (cold) ->', JSON.stringify(await call('slice', {})));
log('slice (warm) ->', JSON.stringify(await call('slice', {})).slice(0, 160));
let total = 0, n = 0;
for (let i = 0; i < 200; i++) {
  const r = await call('slice', {});
  if (!r.sliced) { log('stop', JSON.stringify(r).slice(0, 200)); break; }
  total += r.gained; n++;
  if (i % 15 === 0) log(`slice ${i + 1} gained=${r.gained} score=${r.score_after} rem=${r.state.remaining}`);
  if (r.state.phase !== 'playing') { log('phase', r.state.phase); break; }
}
log('TOTAL', total, 'strokes', n);
await client.close();
