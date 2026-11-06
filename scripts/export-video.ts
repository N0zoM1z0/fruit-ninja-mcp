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
const total = Number(probe.format.duration);
// Preserve every source frame; encoder tail timing is not a game-start reference.
const start = 0,
  duration = total;
const args = [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  source,
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-threads",
  "2",
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
  note: "Original speed and uncut source timeline, including setup, the entire realtime round and result. No trimming or time scaling. Original WebM retained separately.",
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
