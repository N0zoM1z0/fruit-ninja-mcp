import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";

/** Record only the game window, at capture speed. */
export async function startRecording({
  display,
  output,
  fps = 30,
  gameSize = { width: 1024, height: 768 },
}) {
  const filename = path.join(output, "video.mp4");
  const log = createWriteStream(path.join(output, "recording.log"));
  const args = [
    "-y",
    "-loglevel",
    "warning",
    "-filter_complex_threads",
    "1",
    "-filter_threads",
    "1",
    "-thread_queue_size",
    "64",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-f",
    "x11grab",
    "-draw_mouse",
    "1",
    "-framerate",
    String(fps),
    "-video_size",
    `${gameSize.width}x${gameSize.height}`,
    "-i",
    display,
  ];
  if (gameSize.width !== 1024 || gameSize.height !== 768)
    args.push("-vf", "scale=1024:768:flags=bilinear");
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-threads",
    "2",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-fps_mode",
    "cfr",
    "-r",
    String(fps),
    filename,
  );
  const ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  ffmpeg.stderr.pipe(log, { end: false });
  let failure;
  ffmpeg.on("error", (error) => {
    failure = error;
  });
  const finished = new Promise((resolve) =>
    ffmpeg.once("close", (code, signal) => resolve({ code, signal })),
  );
  let closed;
  return {
    filename,
    startedAt: Date.now(),
    close: () =>
      (closed ??= (async () => {
        if (ffmpeg.exitCode === null) ffmpeg.kill("SIGINT");
        const timer = setTimeout(() => ffmpeg.kill("SIGKILL"), 10000);
        const result = await finished;
        clearTimeout(timer);
        await new Promise((resolve) => log.end(resolve));
        if (failure) throw failure;
        if (![0, 255].includes(result.code))
          throw new Error(
            `Recording failed (${result.code ?? result.signal}); see recording.log`,
          );
        return filename;
      })()),
  };
}
