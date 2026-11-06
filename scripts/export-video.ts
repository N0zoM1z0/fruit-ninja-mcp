import { parseArgs } from "node:util";
import { exportVideo } from "../src/evaluator/video.js";

const { values } = parseArgs({
  options: { trial: { type: "string" }, output: { type: "string" } },
});
if (!values.trial)
  throw new Error("Use --trial path/to/recorded/trial [--output game.mp4]");
console.log(
  JSON.stringify(await exportVideo(values.trial, values.output), null, 2),
);
