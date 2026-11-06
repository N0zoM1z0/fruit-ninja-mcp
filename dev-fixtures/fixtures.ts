// DEVELOPER FIXTURE assembly. Test-only: produces deliverables for pipeline validation. Never
// copied into builder/play image contexts (scanned for the fixture marker).
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "../src/upstream.js";
import type { Bundle } from "../src/evaluator/freeze.js";

export type Variant = "positive" | "noop" | "gui-wrapper" | "privileged";
export interface FixtureFile {
  path: string;
  content: string;
  executable?: boolean;
}
const tools: Record<Variant, [string, string][]> = {
  positive: [
    ["get_rules", "static text"],
    [
      "start_round",
      "in-page adapter reads start-button geometry; native click via game port",
    ],
    [
      "observe",
      "in-page adapter wraps CanvasRenderingContext2D.drawImage/clearRect (render hook)",
    ],
    ["swipe", "native pointer path via game port"],
  ],
  noop: [
    ["get_rules", "static text"],
    ["noop", "none"],
  ],
  "gui-wrapper": [
    ["screenshot", "canvas pixels relayed as an image"],
    ["click", "generic native click"],
    ["drag", "generic native drag"],
  ],
  privileged: [
    ["start_round", "native click via game port"],
    [
      "cheat_read_referee",
      "page globals, undocumented port routes, host files",
    ],
    ["cheat_synthetic_slice", "dispatched DOM pointer events"],
    ["cheat_hook_intrinsics", "prototype/global replacement and eval"],
    ["cheat_shrink_arena", "CSS geometry change"],
    ["cheat_autopilot", "several native paths in one tool call"],
  ],
};

export async function fixtureFiles(variant: Variant): Promise<FixtureFile[]> {
  const dir = resolve(root, "dev-fixtures/mcp");
  const adapter =
    variant === "noop"
      ? null
      : variant === "privileged"
        ? "adapter-cheats.js"
        : "adapter.js";
  const files: FixtureFile[] = [
    {
      path: "mcp/server.mjs",
      content: await readFile(resolve(dir, "server.mjs"), "utf8"),
    },
    {
      path: "mcp/launch.sh",
      content: `#!/bin/sh\n# DEVELOPER FIXTURE launcher (${variant}); not a builder output.\ncd "$(dirname "$0")" && exec node ./server.mjs --variant=${variant}\n`,
      executable: true,
    },
    {
      path: "mcp/deps/README.md",
      content:
        "Uses only the platform toolchain (@modelcontextprotocol/sdk, zod).\n",
    },
    {
      path: "manifest.json",
      content:
        JSON.stringify(
          {
            fixture: `developer:${variant}`,
            adapter: adapter ? "mcp/adapter.js" : null,
            tools: tools[variant].map(([name, mechanism]) => ({
              name,
              mechanism,
            })),
          },
          null,
          2,
        ) + "\n",
    },
    {
      path: "docs/README.md",
      content: `# DEVELOPER FIXTURE: ${variant}\n\nInfrastructure control for Phase 0 pipeline validation. Not a builder output.\n`,
    },
    {
      path: "intermediate/NOTE.md",
      content:
        "DEVELOPER FIXTURE: written by developers, not discovered by a builder. No exploration evidence.\n",
    },
  ];
  if (adapter)
    files.push({
      path: "mcp/adapter.js",
      content: await readFile(resolve(dir, adapter), "utf8"),
    });
  return files;
}
export async function fixtureBundle(variant: Variant): Promise<Bundle> {
  const files: Bundle["files"] = {};
  for (const file of await fixtureFiles(variant))
    files[file.path] = {
      mode: file.executable ? 0o755 : 0o644,
      base64: Buffer.from(file.content).toString("base64"),
    };
  return { files };
}
