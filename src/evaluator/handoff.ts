// PRIVATE: replay preflight. Raw frozen developer fixtures deliberately bypass this
// handoff contract, but still undergo full artifact and metadata verification.
import type { SmokeResult } from "./acceptance.js";
import { verifyFrozen } from "./freeze.js";

export interface Handoff {
  sha256: string;
  frozen: string;
  smoke: SmokeResult;
  notes: string | null;
  builder_run: string;
  handed_off_at: string;
}

export async function verifyHandoff(value: unknown) {
  const handoff = value as Handoff | null;
  if (
    !handoff ||
    typeof handoff.frozen !== "string" ||
    !handoff.frozen.trim() ||
    typeof handoff.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(handoff.sha256)
  )
    throw new Error("invalid handoff identity");
  const smoke = handoff.smoke;
  if (
    smoke?.status !== "pass" ||
    !Array.isArray(smoke.reasons) ||
    smoke.reasons.length ||
    !Array.isArray(smoke.stdout_violations) ||
    smoke.stdout_violations.length ||
    smoke.policy?.ok !== true ||
    !Array.isArray(smoke.policy.reasons) ||
    smoke.policy.reasons.length
  )
    throw new Error("handoff requires a passing smoke");
  if (smoke.artifact !== handoff.sha256)
    throw new Error("handoff smoke artifact mismatch");
  const record = await verifyFrozen(handoff.frozen, handoff.sha256);
  return { root: handoff.frozen, record };
}
