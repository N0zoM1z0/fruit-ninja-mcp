# Dependencies

None beyond what the play sandbox already provides.

`mcp/server.js` imports only:

- `node:http` (built in)
- `@modelcontextprotocol/sdk/server/mcp.js`
- `@modelcontextprotocol/sdk/server/stdio.js`
- `zod`

All three packages are part of the toolchain that is present in the play sandbox
(`/opt/toolchain/node_modules`), and bare specifiers resolve from any directory,
so no vendored copy is needed here.

`mcp/adapter.js` is plain ES5-compatible JavaScript with no imports at all: the
host evaluates it inside the game page as a CommonJS-style module body.
