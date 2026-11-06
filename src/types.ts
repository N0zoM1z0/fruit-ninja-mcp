export type GameMode = "classic" | "arcade" | "zen";
export type Interface = "mcp" | "gui";
export interface TimedPoint {
  x: number;
  y: number;
  t_ms: number;
}
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
export interface Swipe {
  expected_revision?: number;
  observed_at_ms?: number;
  points: TimedPoint[];
}
export interface Wait {
  duration_ms: number;
}
