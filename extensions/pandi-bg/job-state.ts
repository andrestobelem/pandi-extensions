// pandi-bg read-time job-state projection. These derive the state a reader should SEE from
// the persisted state + the in-process registry (activeJobs) + a pid liveness/identity
// probe — they never persist and never signal. Pure projection (no fs); the I/O scanning
// (listJobs/eachProjectRunDir/reconcileInterruptedJobs) stays in index.ts and feeds these.

import type { JobState } from "./index.js";
import { probeProcessAlive, verifyProcessIdentity } from "./process-liveness.js";
import { activeJobs, asNumber, asString } from "./runtime-state.js";

// Single read-time projection of the persisted state (the only states a writer can
// know: starting/running/completed/failed/cancelled). When a job is persisted as
// starting/running but is NOT owned by this session, probe the recorded pid to
// distinguish an orphaned-but-alive process from one that died while Pi was down,
// falling back to `stale` only when the pid is unprobeable. Never persisted, never
// signals: cancel still refuses any persisted pid.
export function projectState(
	jobId: string,
	persisted: string | undefined,
	pid: number | undefined,
): { state: JobState; persistedState?: string; hint?: string } {
	if ((persisted === "starting" || persisted === "running") && !activeJobs.has(jobId)) {
		const live = probeProcessAlive(pid);
		if (live === "alive") {
			return {
				state: "orphaned",
				persistedState: persisted,
				hint: `El PID ${pid} podría seguir corriendo (o el PID fue reutilizado). Verificalo antes de usar kill -- -${pid} / taskkill; /bg cancel no le va a enviar una señal a un PID persistido.`,
			};
		}
		if (live === "dead") return { state: "interrupted", persistedState: persisted };
		return { state: "stale", persistedState: persisted };
	}
	return { state: (persisted ?? "unknown") as JobState };
}

export function deriveState(jobId: string, status: Record<string, unknown> | undefined): JobState {
	return projectState(jobId, asString(status?.state) ?? "unknown", asNumber(status?.pid)).state;
}

// Refine a read-time `orphaned` projection with one identity probe: a different start
// identity means the pid was reused (our process is gone => interrupted); a matching
// identity is verified-alive; unknown stays orphaned (best-effort). Shared by /bg status
// and classifyForDeletion so the two never diverge.
export function refineOrphanedIdentity(
	pid: number | undefined,
	startId: string | undefined,
): { state: "orphaned" | "interrupted"; verified: boolean } {
	const identity = verifyProcessIdentity(pid, startId);
	if (identity === "different") return { state: "interrupted", verified: false };
	return { state: "orphaned", verified: identity === "same" };
}

export function decorateStatus(jobId: string, raw: Record<string, unknown>): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...raw };
	const projected = projectState(jobId, asString(copy.state), asNumber(copy.pid));
	copy.state = projected.state;
	if (projected.persistedState !== undefined) copy.persistedState = projected.persistedState;
	if (projected.hint !== undefined) copy.hint = projected.hint;
	copy.active = activeJobs.has(jobId);
	return copy;
}
