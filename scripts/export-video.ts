import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: { trial: { type: "string" }, output: { type: "string" } },
});
if (!values.trial)
  throw new Error("Use --trial path/to/recorded/trial [--output game.mp4]");
const trial = resolve(values.trial),
  source = resolve(trial, "game/game.webm"),
  output = resolve(values.output ?? resolve(trial, "game/game.mp4"));
const result = JSON.parse(
  await readFile(resolve(trial, "result.json"), "utf8"),
);
if (!result.completed_round || result.clock !== "realtime")
  throw new Error("Export requires a completed realtime round");
const probe = JSON.parse(
  execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", source],
    { encoding: "utf8" },
  ),
);
const total = Number(probe.format.duration),
  wallAtLastObservation = result.final_scene.clock_audit.wall_elapsed_ms / 1000;
// Keep pre-roll and the entire game. Only pre-start setup and excess post-round idle are trimmed.
const start = Math.max(0, total - wallAtLastObservation - 1),
  duration = Math.min(total - start, result.duration_seconds + 4);
const args = [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-ss",
  String(start),
  "-i",
  source,
  "-t",
  String(duration),
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  "-fps_mode",
  "passthrough",
  output,
];
const ffmpeg = spawn("ffmpeg", args, { stdio: "inherit" });
const code = await new Promise<number | null>((done, reject) => {
  ffmpeg.once("close", done);
  ffmpeg.once("error", reject);
});
if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
const evidence = {
  source,
  output,
  source_duration_seconds: total,
  trim_start_seconds: start,
  export_duration_seconds: duration,
  speed_factor: 1,
  note: "Original speed. Entire realtime round retained, with pre-roll and final result. Uncut WebM retained separately.",
  source_sha256: createHash("sha256")
    .update(await readFile(source))
    .digest("hex"),
  output_sha256: createHash("sha256")
    .update(await readFile(output))
    .digest("hex"),
  ffmpeg_args: args,
};
await writeFile(output + ".json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
