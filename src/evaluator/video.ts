// Original-speed, uncut MP4 export of a recorded realtime trial, with frame validation.
import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "../upstream.js";

function probe(path: string) {
  return JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_packets",
        "-show_entries",
        "stream=codec_name,width,height,r_frame_rate,nb_read_packets:format=duration",
        "-of",
        "json",
        path,
      ],
      { encoding: "utf8" },
    ),
  );
}
export async function exportVideo(trialDir: string, output?: string) {
  const trial = resolve(trialDir),
    source = resolve(trial, "game/game.webm"),
    target = resolve(output ?? resolve(trial, "game/game.mp4"));
  const result = JSON.parse(
    await readFile(resolve(trial, "result.json"), "utf8"),
  );
  if (!result.completed_round || result.clock !== "realtime")
    throw new Error("Export requires a completed realtime round");
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
    target,
  ];
  const code = await new Promise<number | null>((done, reject) => {
    const ffmpeg = spawn("ffmpeg", args, { stdio: "inherit" });
    ffmpeg.once("close", done);
    ffmpeg.once("error", reject);
  });
  if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
  const webm = probe(source),
    mp4 = probe(target);
  const frames = (p: any) => Number(p.streams?.[0]?.nb_read_packets ?? 0);
  const evidence = {
    source,
    output: target,
    speed_factor: 1,
    note: "Original speed and uncut source timeline, including setup, the realtime round and result. No trimming or time scaling.",
    source_sha256: sha256(await readFile(source)),
    output_sha256: sha256(await readFile(target)),
    validation: {
      webm,
      mp4,
      all_source_frames_retained:
        frames(webm) > 0 && frames(webm) === frames(mp4),
      duration_seconds: Number(mp4.format?.duration ?? 0),
    },
    ffmpeg_args: args,
    score: result.score ?? result.final_scene?.stats?.score ?? null,
  };
  await writeFile(target + ".json", JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}
