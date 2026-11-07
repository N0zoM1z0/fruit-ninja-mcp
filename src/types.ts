export type GameMode = "classic" | "arcade" | "zen";
export type Interface = "mcp" | "gui";
export type McpProfile = "standard" | "fresh" | "async";
export type Feedback = "full" | "compact";
export interface Observe {
  until: "immediate" | "new_fruit";
  timeout_ms: number;
}
export interface ObservationResult {
  scene: Scene;
  trigger:
    "immediate" | "new_fruit" | "timeout" | "round_finished" | "not_started";
  waited_ms: number;
  new_fruit_ids: number[];
}
export type { TimedPoint } from "./public/executor.js";
import type { TimedPoint } from "./public/executor.js";
export interface NewGame {
  mode: GameMode;
  seed: number;
  duration_seconds?: number;
}
export interface GameObject {
  id: number;
  kind: "fruit" | "bomb";
  fruit: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  hit_radius: number;
}
export interface GameStats {
  score: number;
  sliced: number;
  missed: number;
  escaped_fruit: number;
  bombs_hit: number;
  max_combo: number;
  spawned_fruit: number;
}
export interface Scene {
  schema_version: 2;
  round: number;
  revision: number;
  tick: number;
  phase: "ready" | "playing" | "finished";
  mode: GameMode;
  clock: "realtime";
  elapsed_ms: number;
  remaining_ms: number | null;
  arena: { width: number; height: number };
  gravity: number;
  clock_audit: {
    started_at_ms: number | null;
    observed_at_ms: number;
    wall_elapsed_ms: number;
    finished_wall_elapsed_ms: number | null;
    max_pump_gap_ms: number;
  };
  stats: GameStats;
  objects: GameObject[];
}
export interface GameEvent {
  seq: number;
  tick: number;
  at_ms: number;
  wall_ms: number;
  type:
    | "round_started"
    | "fruit_sliced"
    | "bomb_hit"
    | "fruit_escaped"
    | "round_finished";
  object_id?: number;
  fruit?: string;
  points?: number;
}
export interface ActionResult {
  scene: Scene;
  actual_duration_ms: number;
  observed_age_ms: number | null;
  events: GameEvent[];
}
export interface ActionStatus {
  action_id: number;
  status: "completed" | "failed";
  actual_duration_ms?: number;
  events?: GameEvent[];
  error?: string;
}
export interface SubmittedAction {
  accepted: boolean;
  action_id: number;
  scene: Scene;
  pending_action: { action_id: number; status: "executing" } | null;
  previous_action: ActionStatus | null;
}
export interface Swipe {
  expected_revision?: number;
  observed_at_ms?: number;
  points: TimedPoint[];
}
export interface Wait {
  duration_ms: number;
}
