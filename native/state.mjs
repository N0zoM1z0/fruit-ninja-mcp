import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

export const layout = JSON.parse(
  await readFile(new URL("./re-layout.json", import.meta.url), "utf8"),
);
const address = (value) => Number(value);

/** Read the active native lists recovered with REA; never writes target memory. */
export class NativeState {
  constructor(helper) {
    this.helper = helper;
    this.started = false;
    this.clockHistory = [];
    this.observationQueue = Promise.resolve();
  }

  async read(pointer, length) {
    if (this.snapshotCache) {
      const bytes = this.snapshotCache.get(pointer);
      if (!bytes || bytes.length !== length)
        throw new Error("Native snapshot missing a required span");
      return bytes;
    }
    const result = await this.helper.request(`read ${pointer} ${length}`);
    if (!result.ok)
      throw new Error(
        `ReadProcessMemory ${pointer.toString(16)}: ${result.error}`,
      );
    return Buffer.from(result.hex, "hex");
  }

  observe() {
    const operation = this.observationQueue.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (this.helper.nativeSnapshot) {
            this.capturedAt = performance.now();
            const snapshot = await this.helper.request("snapshot");
            if (!snapshot.ok) throw new Error(snapshot.error);
            if (snapshot.captured_epoch_ms)
              this.capturedAt =
                snapshot.captured_epoch_ms - performance.timeOrigin;
            this.snapshotCache = new Map(
              snapshot.spans.map((s) => [s.address, Buffer.from(s.hex, "hex")]),
            );
          }
          const state = await this.readSnapshot();
          if (attempt) state.warnings.push("snapshot-retried");
          return state;
        } catch (error) {
          if (
            !/read-failed|Native entity snapshot changed|Invalid native entity list/.test(
              error.message,
            ) ||
            attempt === 2
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 8));
        } finally {
          this.snapshotCache = undefined;
          this.capturedAt = undefined;
        }
      }
    });
    this.observationQueue = operation.catch(() => {});
    return operation;
  }

  async readSnapshot() {
    const begun = this.capturedAt ?? performance.now();
    const info = await this.helper.request("info");
    if (!info.alive || !info.window)
      throw new Error("Game process/window is unavailable");
    const window = info.window;
    const aspect = window.width / window.height;
    const W = aspect > 1.5 ? 320 * aspect : 480;
    const H = aspect > 1.5 ? 320 : 480 / aspect;
    const canvas = { ...window, W, H };
    delete canvas.hwnd;
    const globals = await this.read(0x5b3070, 0x174);
    const cameraPointer = globals.readUInt32LE(0x4c);
    let camera;
    if (cameraPointer) {
      const bytes = await this.read(cameraPointer, 0x174);
      const active = bytes.readFloatLE(0x160) > 0;
      camera = {
        active,
        zoom: active ? bytes.readFloatLE(0x158) : 1,
        angle: active
          ? ((bytes.readUInt16LE(0x15c) >>> 4) * 2 * Math.PI) / 4096
          : 0,
        x: active ? bytes.readFloatLE(0x14c) - bytes.readFloatLE(0x144) : 0,
        y: active ? bytes.readFloatLE(0x150) - bytes.readFloatLE(0x148) : 0,
      };
      canvas.camera = camera;
    }
    const resultScreen = globals.readUInt32LE(0x16c) !== 0;
    // 0x5b2b90 is cleared by the render callback. The integer tick counter is
    // cumulative; each update adds trunc(dt * 1000), so it has frame rounding.
    const simTime = (await this.read(0x5b3210, 4)).readUInt32LE() / 1000;
    const clockAt = this.capturedAt ?? performance.now();
    this.clockHistory = this.clockHistory.filter(
      (sample) => clockAt - sample.wall < 1500 && sample.sim <= simTime,
    );
    this.clockHistory.push({ wall: clockAt, sim: simTime });
    const oldClock = this.clockHistory[0];
    const span = (clockAt - oldClock.wall) / 1000;
    const simulationRate =
      span >= 0.4
        ? Math.max(0.01, Math.min(1.2, (simTime - oldClock.sim) / span))
        : 0.94;
    const config = globals.readUInt32LE(0x50);
    const remaining = config
      ? (await this.read(config + 0x104, 4)).readFloatLE()
      : null;
    // The evaluator may initialize Arcade for either interface. GUI actors
    // still receive pixels only; the private referee recognizes native start.
    if (
      !resultScreen &&
      globals[8] === 0 &&
      globals.readInt32LE(4) === 2 &&
      remaining > 0 &&
      remaining <= 60
    )
      this.started = true;
    const root = (
      await this.read(
        address(layout.entities.list_descriptors_pointer_address),
        4,
      )
    ).readUInt32LE();
    if (root < 0x10000) throw new Error("Native entity manager is not ready");
    const descriptors = await this.read(root, 24);
    const groups = { fruits: [], bombs: [] };
    const fruitMetadata =
      this.snapshotCache?.get(0x5b2adc)?.readUInt32LE() ?? 0;
    const warnings = [];
    for (const [type, name] of [
      [0, "fruits"],
      [1, "bombs"],
    ]) {
      const spec = type ? layout.bomb : layout.fruit;
      const sentinel = descriptors.readUInt32LE(type * 12);
      const count = descriptors.readUInt32LE(type * 12 + 4);
      if (count > 256 || sentinel < 0x10000)
        throw new Error("Invalid native entity list");
      let node = (await this.read(sentinel, 4)).readUInt32LE();
      const seen = new Set();
      for (let index = 0; index < count && node !== sentinel; index++) {
        if (seen.has(node) || node < 0x10000)
          throw new Error("Native entity snapshot changed");
        seen.add(node);
        const links = await this.read(node, 12);
        const ptr = links.readUInt32LE(8);
        node = links.readUInt32LE(0);
        if (ptr < 0x10000) throw new Error("Native entity snapshot changed");
        const entity = await this.read(ptr, spec.allocation_size);
        if (entity.readUInt32LE() !== address(spec.vtable_address)) continue;
        const flags = entity.readUInt32LE(layout.common.flags_offset);
        if (flags & layout.common.pending_removal_mask) continue;
        if (entity[type ? spec.exploded_u8_offset : spec.sliced_u8_offset])
          continue;
        if (
          this.started &&
          !resultScreen &&
          !type &&
          entity.readFloatLE(spec.slice_pending_f32_offset) > -1
        )
          continue;
        if (entity.readFloatLE(spec.spawn_delay_f32_offset) > 0) continue;
        const collider = entity.readUInt32LE(
          layout.common.collider_pointer_offset,
        );
        if (!collider) continue;
        const radius = (
          await this.read(
            collider + layout.common.collider_radius_f32_offset,
            4,
          )
        ).readFloatLE();
        const [x, y, z] = layout.common.position_f32_offsets.map((offset) =>
          entity.readFloatLE(offset),
        );
        const [vx, vy] = layout.common.velocity_f32_offsets.map((offset) =>
          entity.readFloatLE(offset),
        );
        const scale = entity.readFloatLE(spec.time_scale_f32_offset);
        const moving =
          Boolean(entity[spec.physics_enabled_u8_offset]) &&
          !(type === 0 && entity[spec.frozen_u8_offset]);
        const ay = entity.readFloatLE(spec.acceleration_f32_offsets[1]);
        if (
          ![x, y, z, vx, vy, radius, scale, ay].every(Number.isFinite) ||
          radius <= 0 ||
          radius > 200
        )
          continue;
        let reward = 1,
          powerup = 0;
        if (!type && fruitMetadata) {
          const meta = await this.read(
            fruitMetadata + entity[0x3c] * 0x338 + 0x314,
            0x20,
          );
          reward = meta.readInt32LE();
          powerup = meta.readUInt32LE(0x18);
        }
        groups[name].push({
          id: `0x${ptr.toString(16)}`,
          kind: !type ? entity[0x3c] : null,
          z,
          ...(!type ? { wave: entity.readInt32LE(0x84), reward, powerup } : {}),
          x: x + W / 2,
          y: H / 2 - y,
          r: radius,
          vx: moving ? vx * 60 * scale * simulationRate : 0,
          vy: moving ? -vy * 60 * scale * simulationRate : 0,
          gravity: moving ? -ay * 60 * (scale * simulationRate) ** 2 : 0,
          age_ms: 0,
          moving,
          sampled_at: this.capturedAt ?? performance.now(),
        });
      }
    }
    // Reject a torn list rather than planning against missing bomb entries.
    if (!descriptors.equals(await this.read(root, 24)))
      throw new Error("Native entity snapshot changed");
    const now = performance.now();
    for (const group of Object.values(groups))
      for (const entity of group) {
        entity.age_ms = now - entity.sampled_at;
        delete entity.sampled_at;
      }
    return {
      now,
      phase: resultScreen
        ? "result"
        : this.started
          ? globals[2]
            ? "paused"
            : "playing"
          : "menu",
      mode: ["classic", "zen", "arcade"][globals.readInt32LE(4)] ?? "unknown",
      score: globals.readInt32LE(0x1c),
      remaining: Number.isFinite(remaining) ? remaining : null,
      gravity: 720,
      canvas,
      ...groups,
      observation_ms: now - begun,
      simulation_rate: simulationRate,
      warnings,
    };
  }
}
