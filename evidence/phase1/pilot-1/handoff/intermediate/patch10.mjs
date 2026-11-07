import { readFileSync, writeFileSync } from 'node:fs';
const p = '/output/docs/README.md';
let s = readFileSync(p, 'utf8');
s = s.replace(
  'Every tool call issues **at most one** native input, as required.',
  `Every tool call issues **at most one** native input, as required.

If \`slice\` / \`slice_fruit\` is called while the round is still on the menu, it spends
that call's single input on the start button and reports \`reason: "round-started"\`;
the next call strikes.  \`start_round\` remains available for an explicit start.`,
);
writeFileSync(p, s);
console.log('ok');
