// PRIVATE: validate an agent deliverable and freeze it by content hash (adapted from the
// REA builder freeze: complete deliverable, safe paths, fixed modes, immutable inventory).
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
  chmod,
} from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import { parse } from "acorn";
import { isDeepStrictEqual } from "node:util";
import { sha256 } from "../upstream.js";

export interface Bundle {
  files: Record<string, { mode: number; base64: string }>;
}
export interface ManifestTool {
  name: string;
  mechanism: string;
  free_form?: boolean;
  requires_review?: boolean;
}
export interface Manifest {
  tools: ManifestTool[];
  adapter?: string | null;
  fixture?: string;
  [key: string]: unknown;
}
export interface FrozenRecord {
  sha256: string;
  files: Record<string, { sha256: string; mode: number; bytes: number }>;
  manifest: Manifest;
  adapter: { path: string; sha256: string } | null;
  frozen_at: string;
}
const tops = new Set(["mcp", "manifest.json", "docs", "intermediate"]);
export const freezeLimits = {
  files: 4000,
  bytes: 64 * 1024 * 1024,
  adapter_bytes: 512 * 1024,
};

export function inventoryDigest(files: FrozenRecord["files"]): string {
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return sha256(JSON.stringify(sorted));
}

export function validateBundle(bundle: Bundle) {
  if (!bundle || typeof bundle.files !== "object")
    throw new Error("incomplete deliverable: no files");
  const entries = Object.entries(bundle.files);
  if (entries.length > freezeLimits.files) throw new Error("too many files");
  const decoded = new Map<string, Buffer>();
  const inventory: FrozenRecord["files"] = {};
  let total = 0;
  for (const [name, row] of entries) {
    const normal = posix.normalize(name);
    if (
      !name ||
      name !== normal ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name
        .split("/")
        .some((part) => part === ".." || part === "." || part === "") ||
      !tops.has(name.split("/")[0])
    )
      throw new Error(`unsafe artifact path: ${name}`);
    if (row.mode !== 0o644 && row.mode !== 0o755)
      throw new Error(
        `unsupported file mode for ${name}: ${row.mode.toString(8)}`,
      );
    const data = Buffer.from(row.base64, "base64");
    if (data.toString("base64") !== row.base64.replace(/\s/g, ""))
      throw new Error(`invalid base64 for ${name}`);
    total += data.length;
    if (total > freezeLimits.bytes) throw new Error("artifact exceeds 64 MiB");
    decoded.set(name, data);
    inventory[name] = {
      sha256: sha256(data),
      mode: row.mode,
      bytes: data.length,
    };
  }
  const missing = ["mcp/launch.sh", "manifest.json", "docs/README.md"].filter(
    (p) => !decoded.has(p),
  );
  if (missing.length)
    throw new Error(`incomplete deliverable: missing ${missing.join(", ")}`);
  if (![...decoded.keys()].some((p) => p.startsWith("intermediate/")))
    throw new Error(
      "incomplete deliverable: intermediate/ evidence is required",
    );
  if (![...decoded.keys()].some((p) => p.startsWith("mcp/deps/")))
    throw new Error(
      "incomplete deliverable: mcp/deps/ is required (a README is enough)",
    );
  if (inventory["mcp/launch.sh"].mode !== 0o755)
    throw new Error("mcp/launch.sh must be executable (0755)");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(decoded.get("manifest.json")!.toString("utf8"));
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  if (!Array.isArray(manifest.tools) || !manifest.tools.length)
    throw new Error("manifest must list each tool and its mechanism");
  const names = new Set<string>();
  for (const tool of manifest.tools) {
    if (
      typeof tool?.name !== "string" ||
      typeof tool?.mechanism !== "string" ||
      !tool.mechanism.trim()
    )
      throw new Error(
        "incomplete tool provenance: each tool needs name and mechanism",
      );
    if (names.has(tool.name))
      throw new Error(`duplicate manifest tool ${tool.name}`);
    names.add(tool.name);
  }
  let adapter: FrozenRecord["adapter"] = null;
  if (manifest.adapter !== undefined && manifest.adapter !== null) {
    const path = manifest.adapter;
    if (
      typeof path !== "string" ||
      !path.startsWith("mcp/") ||
      !decoded.has(path)
    )
      throw new Error("manifest.adapter must name a file under mcp/");
    const source = decoded.get(path)!;
    if (source.length > freezeLimits.adapter_bytes)
      throw new Error("adapter exceeds 512 KiB");
    try {
      parse(`(function(module, exports){\n${source.toString("utf8")}\n})`, {
        ecmaVersion: "latest",
      });
    } catch (error) {
      throw new Error(`adapter does not parse: ${(error as Error).message}`);
    }
    adapter = { path, sha256: inventory[path].sha256 };
  }
  return { decoded, inventory, manifest, adapter };
}

export async function freeze(
  bundle: Bundle,
  destination: string,
): Promise<{ root: string; record: FrozenRecord }> {
  const { decoded, inventory, manifest, adapter } = validateBundle(bundle);
  const digest = inventoryDigest(inventory);
  const root = resolve(destination, digest);
  await mkdir(root, { recursive: true, mode: 0o755 });
  for (const [name, data] of decoded) {
    const path = join(root, ...name.split("/"));
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o755 });
    const existing = await readFile(path).catch(() => null);
    if (existing && !existing.equals(data))
      throw new Error("frozen artifact changed");
    if (!existing) await writeFile(path, data);
    await chmod(path, inventory[name].mode);
  }
  const record: FrozenRecord = {
    sha256: digest,
    files: inventory,
    manifest,
    adapter,
    frozen_at: new Date().toISOString(),
  };
  await writeFile(
    resolve(root, "build.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  return { root, record };
}

/** Re-hash a frozen artifact before deployment; any change, addition or link fails closed. */
export async function verifyFrozen(
  root: string,
  expectedSha256?: string,
): Promise<FrozenRecord> {
  const record = JSON.parse(
    await readFile(resolve(root, "build.json"), "utf8"),
  ) as FrozenRecord;
  if (inventoryDigest(record.files) !== record.sha256)
    throw new Error("frozen inventory digest mismatch");
  if (expectedSha256 !== undefined && record.sha256 !== expectedSha256)
    throw new Error("handoff artifact digest mismatch");
  const bundle: Bundle = { files: {} };
  const seen = new Set<string>();
  const walk = async (directory: string) => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name),
        stat = await lstat(path),
        rel = relative(root, path).split("\\").join("/");
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) {
        if (rel === "build.json") continue;
        const row = record.files[rel];
        if (!row) throw new Error(`unexpected file in frozen artifact: ${rel}`);
        const data = await readFile(path);
        if (
          sha256(data) !== row.sha256 ||
          (stat.mode & 0o777) !== row.mode ||
          data.length !== row.bytes
        )
          throw new Error(`frozen bytes or mode changed: ${rel}`);
        bundle.files[rel] = { mode: row.mode, base64: data.toString("base64") };
        seen.add(rel);
      } else throw new Error(`links and special files are forbidden: ${rel}`);
    }
  };
  await walk(root);
  const absent = Object.keys(record.files).filter((p) => !seen.has(p));
  if (absent.length)
    throw new Error(`frozen files missing: ${absent.join(", ")}`);
  // build.json is a record, not the source of executable metadata. Reconstruct it
  // from the inventory-protected bytes and reject stale or edited copied fields.
  const { inventory, manifest, adapter } = validateBundle(bundle);
  if (inventoryDigest(inventory) !== record.sha256)
    throw new Error("frozen inventory digest mismatch");
  if (
    !isDeepStrictEqual(record.manifest, manifest) ||
    !isDeepStrictEqual(record.adapter, adapter)
  )
    throw new Error("frozen metadata mismatch");
  return { ...record, files: inventory, manifest, adapter };
}
