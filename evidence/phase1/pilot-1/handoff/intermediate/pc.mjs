import { GamePortClient } from '/opt/toolchain/fn/port-client.js';
const c = new GamePortClient(process.env.FN_GAME_PORT || '/work/port.sock');
const [op, ...rest] = process.argv.slice(2);
const out = await (async () => {
  if (op === 'info') return c.info();
  if (op === 'status') return c.status();
  if (op === 'adapter') return c.adapter(rest[0], rest[1] ? JSON.parse(rest[1]) : null);
  if (op === 'click') return c.click(Number(rest[0]), Number(rest[1]));
  if (op === 'path') return c.path(JSON.parse(rest[0]), { wait: rest[1] !== 'nowait' });
  throw new Error('unknown op ' + op);
})();
console.log(JSON.stringify(out, null, 1));
