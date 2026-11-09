#!/usr/bin/env node
/** Derive a side-by-side viewing copy; preserve both complete originals. */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
const output = path.resolve(
  process.argv[2] ?? ".local/windows/comparisons/terra-high-ready-game-only",
);
const [mcp, gui] = await Promise.all(
  ["mcp", "gui"].map(async (mode) =>
    JSON.parse(
      await readFile(path.join(output, mode, "metadata.json"), "utf8"),
    ),
  ),
);
const duration =
  Math.max(
    mcp.native_round_wall_seconds + mcp.result_settle_seconds,
    gui.native_round_wall_seconds + gui.result_settle_seconds,
  ) + 0.5;
const cell =
  mcp.video.width === 1024 && gui.video.width === 1024
    ? "1024:768"
    : "1092:576";
const filter = `[0:v]trim=start=${mcp.gameplay_start_video_s},setpts=PTS-STARTPTS,scale=${cell},tpad=stop_mode=clone:stop_duration=40[a];[1:v]trim=start=${gui.gameplay_start_video_s},setpts=PTS-STARTPTS,scale=${cell},tpad=stop_mode=clone:stop_duration=40[b];[a][b]hstack=inputs=2[v]`;
const args = [
  "-y",
  "-v",
  "warning",
  "-filter_complex_threads",
  "1",
  "-threads",
  "2",
  "-i",
  path.join(output, "mcp/video.mp4"),
  "-threads",
  "2",
  "-i",
  path.join(output, "gui/video.mp4"),
  "-filter_complex",
  filter,
  "-map",
  "[v]",
  "-t",
  String(duration),
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-threads",
  "2",
  "-crf",
  "21",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  path.join(output, "comparison.mp4"),
];
await writeFile(
  path.join(output, "composition.json"),
  JSON.stringify(
    {
      args,
      alignment:
        "Aligned to common harness completion / first positive native clock; no speed change; shorter result held as a still. Individual video.mp4 files retain menus and full original run.",
    },
    null,
    2,
  ) + "\n",
);
const child = spawn("ffmpeg", args, { stdio: "inherit" });
await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`)),
  );
});
