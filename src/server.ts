import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GameRuntime, viewport } from "./runtime.js";
import type {
  Interface,
  McpProfile,
  Scene,
  ObservationResult,
  Feedback,
} from "./types.js";
import { enrichObservation } from "./observation.js";
import { compactObservation } from "./compact.js";

const point = z
  .object({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    t_ms: z.number().int().min(0).max(1000),
  })
  .strict();
export const rules = {
  clock: "realtime",
  timing:
    "After starting, the game runs continuously on monotonic wall time, including thinking, all observations, screenshots and input calls. Nothing pauses or advances it by request. Observations become stale while you reason. A path takes real time to execute.",
  physics:
    "Fixed 120 Hz, normal game gravity and launch speed. For a short time t, x≈x0+vx*t, y≈y0+vy*t+0.5*g*t². Both arms disable camera shake and visual slow motion; neither arm slows the game.",
  blade: {
    minimum_duration_ms: 16,
    maximum_duration_ms: 1000,
    maximum_points: 32,
    maximum_speed_px_s: 5000,
    semantics:
      "One continuous mouse-down path, then mouse-up. No targeting or path planning in the executor. Native browser mouse events and the game's collision detector are shared by MCP and GUI.",
  },
  scoring:
    "Fruit gives 1 point; 3+ fruit in one stroke can earn a bonus. Gaps over 340ms break combos. Arcade: bombs subtract 10 (floor 0); every 20 sliced fruit triggers 6s of double points and removes active bombs. Classic: a bomb or 3 escapes ends the game. Zen: no bombs or escape penalty.",
  session:
    "One prepared round. Start when ready; it never pauses, resets, or restarts. Finishing early does not stop the independent game clock.",
};

export function buildServer(
  runtime: GameRuntime,
  mode: Interface = "mcp",
  profile: McpProfile = "standard",
  feedback: Feedback = "full",
): McpServer {
  let lastObservationAt: number | undefined;
  const latencies: number[] = [];
  const deliver = (scene: Scene) => {
    lastObservationAt = scene.clock_audit.observed_at_ms;
    const sorted = [...latencies].sort((a, b) => a - b),
      estimate = sorted.length
        ? Math.round(sorted[Math.floor(sorted.length / 2)])
        : null;
    const value =
      profile === "fresh" ? enrichObservation(scene, estimate) : scene;
    return feedback === "compact" ? compactObservation(value) : value;
  };
  const deliverObservation = (observation: ObservationResult) => ({
    ...observation,
    scene: deliver(observation.scene),
  });
  const server = new McpServer(
    {
      name: mode === "mcp" ? "fruit-ninja-mcp" : "fruit-ninja-gui",
      version: "0.2.0",
    },
    {
      instructions:
        mode === "mcp"
          ? "Play a continuously running REALTIME game. Read controls and scene, then start_game once. Thinking, observations and input calls all consume real game time. Use visible-object state and your own timed canvas paths. No reset, pause, future spawns or autopilot. Act sequentially and reuse action results; state may be stale by the time an action executes."
          : "Operate the REALTIME Fruit Ninja browser using screenshots and native mouse coordinates only. Read get_controls and screenshot, find the start button in the image, click it, then drag through fruit and avoid bombs. The game never pauses during thinking, screenshots or input. No DOM, OCR, object state, app commands, resets or developer tools are available. Coordinates are full-image pixels.",
    },
  );
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    readOnly = false,
  ): void {
    const schema = z.object(shape).strict();
    server.registerTool<z.ZodRawShape, typeof schema>(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: false,
          idempotentHint: readOnly,
          openWorldHint: false,
        },
      },
      async (args): Promise<CallToolResult> => {
        try {
          const value = await handler(schema.parse(args));
          if (value && typeof value === "object" && "content" in value)
            return value as CallToolResult;
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value as Record<string, unknown>,
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }
  const screenshot = async (): Promise<CallToolResult> => ({
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data: (await runtime.screenshot(profile === "async")).toString(
          "base64",
        ),
      },
    ],
  });
  if (mode === "gui") {
    tool(
      "get_controls",
      "Read static game rules and generic mouse controls. No dynamic game state is provided.",
      {},
      async () => ({
        ...rules,
        viewport,
        ...(profile === "async"
          ? {
              execution:
                "submit_drag acknowledges one bounded path immediately and captures a screenshot while it executes. Plan the next path during execution. At most one path can execute; busy requests are rejected without queuing. Action status contains only generic executor information.",
            }
          : {}),
        coordinates:
          "Full screenshot pixels. Find the start button and arena visually. Drag points use t_ms starting at 0.",
      }),
      true,
    );
    tool(
      "get_screenshot",
      "Capture the real browser image. The game continues during capture and while you reason. No extracted text or state accompanies the image.",
      {},
      screenshot,
      true,
    );
    tool(
      "click",
      "Ordinary native left mouse click in full screenshot pixels; returns the next screenshot. Start by clicking the visible start button.",
      {
        x: z.number().finite().min(0).max(viewport.width),
        y: z.number().finite().min(0).max(viewport.height),
      },
      async ({ x, y }) => {
        await runtime.click(x, y);
        return screenshot();
      },
    );
    tool(
      profile === "async" ? "submit_drag" : "drag",
      profile === "async"
        ? "Submit your native mouse-down path in full screenshot pixels. Acknowledge acceptance immediately with a current screenshot; the path continues while you plan. One active path only, no queued strokes. 2..32 points, 16..1000ms, max 5000px/s. Generic action status contains no game state."
        : "Native mouse-down path in full screenshot pixels, then release. 2..32 points; t_ms starts at 0 and strictly increases, total 16..1000ms, max 5000px/s. The path takes real wall time; returns only a screenshot.",
      { points: z.array(point).min(2).max(32) },
      async ({ points }) => {
        if (profile === "async") {
          const result = await runtime.submitPath({ points }, "screen");
          const previous = result.previous_action;
          const status = {
            accepted: result.accepted,
            action_id: result.action_id,
            pending_action: result.pending_action,
            previous_action: previous
              ? {
                  action_id: previous.action_id,
                  status: previous.status,
                  actual_duration_ms: previous.actual_duration_ms,
                  error: previous.error,
                }
              : null,
          };
          return {
            content: [
              { type: "text", text: JSON.stringify(status) },
              ...(await screenshot()).content,
            ],
          };
        }
        await runtime.guiDrag(points);
        return screenshot();
      },
    );
    tool(
      "wait",
      "Sleep 1..3000 real milliseconds with the mouse released, then capture a screenshot. The game keeps moving.",
      { duration_ms: z.number().int().min(1).max(3000) },
      async (input) => {
        await runtime.wait(input);
        return screenshot();
      },
    );
    return server;
  }
  tool(
    "get_game_rules",
    "Read realtime timing, shared physics/scoring and bounded input limits.",
    {},
    async () => ({
      ...rules,
      mcp_profile: profile,
      feedback,
      ...(profile === "async"
        ? {
            execution:
              "submit_swipe acknowledges your bounded path immediately with current state. The native mouse continues that fixed path while you plan. One active path only; busy requests never queue another stroke. No automatic target selection, chaining or replanning.",
          }
        : {}),
      ...(profile === "fresh"
        ? {
            observation:
              "start_game waits for first visible fruit; swipe waits for newly visible fruit after its path unless observe_after=immediate. These are real waits while the world runs. Lifetime estimates use only visible position, velocity and gravity. reaction_latency_estimate_ms is the recent observation-to-next-request delay; account for it. No future spawns are revealed.",
          }
        : {}),
      coordinates:
        "Canvas pixels, origin top-left, velocities px/s and gravity px/s². Scene includes only current visible objects, with no future spawn or RNG access.",
    }),
    true,
  );
  tool(
    "get_scene",
    "Read a timestamped CURRENT scene: visible fruit/bombs, velocities, hit radii, score, events and wall-clock audit. Time does not stop. Read rules and prepare before starting.",
    {},
    async () => {
      const scene = await (profile === "async"
        ? runtime.peek()
        : runtime.scene());
      return profile === "async"
        ? { scene: deliver(scene), ...runtime.actionStatus() }
        : deliver(scene);
    },
    true,
  );
  tool(
    "start_game",
    "Start the one prepared round NOW. From this moment the world moves during inference, screenshots and every call. No reset or restart is permitted.",
    {},
    async () => {
      const scene = await runtime.start();
      if (profile === "fresh") {
        if (lastObservationAt !== undefined)
          latencies.push(scene.clock_audit.observed_at_ms - lastObservationAt);
        return deliverObservation(
          await runtime.observe({ until: "new_fruit", timeout_ms: 1800 }),
        );
      }
      return deliver(scene);
    },
  );
  if (profile === "fresh")
    tool(
      "observe",
      "Observe immediately, or wait in REAL time until a new fruit first intersects the visible viewport AFTER this request. Returns current visible objects, public kinematic lifetime estimates and a trigger. No future spawns or hidden objects are returned. Time continues throughout the wait.",
      {
        until: z.enum(["immediate", "new_fruit"]).default("new_fruit"),
        timeout_ms: z.number().int().min(1).max(2500).default(1800),
      },
      async (input) => deliverObservation(await runtime.observe(input)),
      true,
    );
  tool(
    profile === "async" ? "submit_swipe" : "swipe",
    profile === "async"
      ? "Submit your timed canvas path and return current scene and acceptance immediately. The fixed path continues for at most 1000ms while you plan. One active path only; busy requests never queue future strokes. Every coordinate and timing comes from you; no backend aiming or replanning. Inspect pending_action and previous_action for execution status."
      : "Execute your timed canvas path using native browser mouse events. The world keeps moving. No automatic aiming. Returns scene/events. In the fresh profile, observe_after defaults to new_fruit: after the stroke the response waits in real time for newly visible fruit, giving the next decision a fresher observation. Choose immediate to inspect the stroke outcome now.",
    {
      points: z.array(point).min(2).max(32),
      expected_revision: z.number().int().min(0).optional(),
      observed_at_ms: z.number().finite().min(0).optional(),
      ...(profile === "fresh"
        ? {
            observe_after: z
              .enum(["immediate", "new_fruit"])
              .default("new_fruit"),
          }
        : {}),
    },
    async (input) => {
      if (profile === "async") {
        const result = await runtime.submitPath(
          {
            ...input,
            observed_at_ms: input.observed_at_ms ?? lastObservationAt,
          },
          "canvas",
        );
        return { ...result, scene: deliver(result.scene) };
      }
      const result = await runtime.swipe({
        ...input,
        ...(profile === "fresh" && input.observed_at_ms === undefined
          ? { observed_at_ms: lastObservationAt }
          : {}),
      });
      if (profile !== "fresh")
        return feedback === "compact"
          ? { ...result, scene: deliver(result.scene) }
          : result;
      if (result.observed_age_ms !== null) {
        latencies.push(result.observed_age_ms);
        if (latencies.length > 5) latencies.shift();
      }
      if (
        (input as { observe_after?: string }).observe_after !== "immediate" &&
        result.scene.phase === "playing"
      ) {
        const observation = await runtime.observe({
          until: "new_fruit",
          timeout_ms: 1800,
        });
        return {
          ...result,
          scene: deliver(observation.scene),
          observation: {
            trigger: observation.trigger,
            waited_ms: observation.waited_ms,
            new_fruit_ids: observation.new_fruit_ids,
          },
        };
      }
      return { ...result, scene: deliver(result.scene) };
    },
  );
  tool(
    "wait",
    "Sleep in real time for 1..3000ms with the blade lifted, then return the current scene. This does not control or pause the game clock.",
    { duration_ms: z.number().int().min(1).max(3000) },
    async (input) => {
      const result = await runtime.wait(input);
      return profile === "fresh" || feedback === "compact"
        ? { ...result, scene: deliver(result.scene) }
        : result;
    },
  );
  tool(
    "get_events",
    "Read actual slice, escape, bomb and round events since a sequence number. The game keeps running.",
    {
      after_seq: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    },
    ({ after_seq, limit }) => runtime.events(after_seq, limit),
    true,
  );
  tool(
    "get_screenshot",
    "Inspect the real rendered browser. Capture and inference time count toward the running game.",
    {},
    screenshot,
    true,
  );
  return server;
}

export async function serve(
  runtime: GameRuntime,
  mode: Interface = "mcp",
  profile: McpProfile = "standard",
  feedback: Feedback = "full",
): Promise<void> {
  const server = buildServer(runtime, mode, profile, feedback);
  const close = async () => {
    await server.close();
    await runtime.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  server.server.onclose = () => void runtime.close();
  await server.connect(new StdioServerTransport());
}
