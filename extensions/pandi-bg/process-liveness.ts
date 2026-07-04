/**
 * Pure process liveness/identity helpers for `/bg`.
 *
 * This slice has NO dependency on the activeJobs map or other module-mutable state:
 * given a pid (and optionally a recorded start id) it inspects the OS to label
 * whether a process is alive and whether it is still OUR job. Kept separate so the
 * read-time projection logic in index.ts can stay focused on job state.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type Liveness = "alive" | "dead" | "unknown";

// Best-effort, synchronous liveness check. process.kill(pid, 0) sends NO signal; it
// only asks the OS whether a process with that pid exists. Cross-platform (Windows
// included). NOTE: a pid can be reused after the original process is reaped, so
// "alive" means "some process holds this pid", not "our job is still running" — the
// reason we only use this to LABEL a read, never to signal a persisted pid.
// A pid we can actually probe: a positive integer. Excludes undefined, 0, negatives
// (e.g. process-group ids), and non-integers.
function isUsablePid(pid: number | undefined): pid is number {
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

// Capture a stable per-process start identity so a later probe can distinguish our
// job's process from an unrelated one that reused its pid. Best-effort, degrading
// across platforms: Linux reads /proc (no subprocess); macOS/BSD shell out to
// `ps -o lstart=`; anything else (e.g. Windows) returns undefined and callers fall
// back to the existing best-effort liveness label.
export function readProcessStartId(pid: number | undefined): string | undefined {
	if (!isUsablePid(pid)) return undefined;
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			// comm can contain spaces/parens, so parse fields after the last ')'. starttime is
			// field 22 (1-indexed) => index 19 of the post-comm tokens.
			const afterComm = stat
				.slice(stat.lastIndexOf(")") + 1)
				.trim()
				.split(/\s+/);
			const starttime = afterComm[19];
			return starttime ? `lin:${starttime}` : undefined;
		}
		if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
			const res = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
			const out = res.status === 0 ? (res.stdout ?? "").trim() : "";
			return out ? `ps:${out}` : undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// Confirm a live pid still belongs to OUR job by comparing its current start identity
// to the one recorded at spawn. "same" = verified our process; "different" = the pid
// was reused (our process is gone); "unknown" = cannot tell (no recorded id, or the
// current id is unreadable) => callers keep best-effort behavior and never claim reuse.
export function verifyProcessIdentity(
	pid: number | undefined,
	recordedStartId: string | undefined,
): "same" | "different" | "unknown" {
	if (!recordedStartId) return "unknown";
	const current = readProcessStartId(pid);
	if (current === undefined) return "unknown";
	return current === recordedStartId ? "same" : "different";
}

export function probeProcessAlive(pid: number | undefined): Liveness {
	if (!isUsablePid(pid)) return "unknown";
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM") return "alive"; // exists but owned by another user
		if (code === "ESRCH") return "dead"; // no such process
		return "unknown";
	}
}
