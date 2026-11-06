import { installGame, upstream } from "../src/upstream.js";

console.log(`Installed ${await installGame()}`);
console.log(`Upstream ${upstream.revision}; SHA-256 ${upstream.sha256}`);
