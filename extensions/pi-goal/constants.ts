/**
 * Module-level constants for the `/goal` extension, factored into a sibling so
 * index.ts keeps only the engine/wiring. These are pure values (no closure over
 * mutable state or runtime objects); each is exported and imported back into
 * index.ts, so the extension's behavior and public surface are unchanged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

/**
 * Bin name of the HOST distribution (bin === piConfig.name: "pi" under vanilla pi,
 * "pi-cante" under pi-cante), read from the host package.json. Falls back to "pi".
 * Deliberately duplicated per extension (self-contained-extension rule).
 */
function hostBinName(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")) as {
			piConfig?: { name?: string };
		};
		return pkg.piConfig?.name || "pi";
	} catch {
		return "pi";
	}
}

export const GOAL_STATE_TYPE = "goal-state";
export const GOAL_STATUS_KEY = "goal";
export const GOAL_DIR = "goals";
export const STATE_FILE = "state.json";
export const DEFAULT_MAX_ITERATIONS = 30;
// Optional external-wait bounds (seconds): the model only sets waitSeconds when it is
// waiting on a real external signal; by default re-injection is immediate (delay 0).
export const MIN_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 3600;
// Safety-net cadence when a turn closed without the model calling goal_progress.
export const SAFETY_NET_DELAY_SECONDS = 1500;
// Best-effort context-usage percent cap (stop if getContextUsage().percent exceeds).
export const DEFAULT_CONTEXT_PERCENT_CAP = 90;
// How many recent assessments to keep in the progress log (bounded continuity).
export const PROGRESS_LOG_KEEP = 12;
// How many failed SELF completeness checks (done → verifying → continue) we tolerate
// before we stop the goal as blocked. Defends against a "self-declares done, fails the
// check, keeps going" ping-pong silently burning the whole iteration budget without
// progress. DISTINCT from DEFAULT_MAX_INDEPENDENT_VERIFICATIONS below: this caps the
// model judging ITSELF (verifying); that one caps the independent read-only judge
// (verifying-independent).
export const MAX_VERIFY_ATTEMPTS = 3;

// --- P1: independent adversarial verification (defaults) ---------------------
// The verifier subagent (separate `pi -p` process) gets READ-ONLY tools only: it
// judges, it never mutates the workspace.
export const DEFAULT_VERIFIER_TOOLS = ["read", "grep", "find", "ls"] as const;
// Wall-clock budget for one independent verification (ms). Generous: the subagent may
// read files and run a few greps before emitting its verdict.
export const DEFAULT_VERIFIER_TIMEOUT_MS = 120_000;
// How many FAILED independent verifications we tolerate before stopping as blocked.
// Small on purpose: a model that keeps claiming done while an independent judge keeps
// failing it needs a human, not more turns. DISTINCT from MAX_VERIFY_ATTEMPTS above:
// that caps the SELF check (verifying); this caps the independent judge
// (verifying-independent). Each independent round spawns a separate `pi -p` process,
// so this gate is not free — keep it small.
export const DEFAULT_MAX_INDEPENDENT_VERIFICATIONS = 2;
// pi command used to spawn the verifier subagent (mirrors dynamic-workflows.ts).
// Defaults to the HOST distribution's own binary (bin name === piConfig.name) so the
// independent verifier runs the same distribution; the env override still wins.
export const PI_COMMAND = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND || hostBinName();
