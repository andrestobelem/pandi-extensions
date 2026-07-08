// Proyección read-time de job-state de pandi-bg. Deriva el estado que un lector debe VER desde
// el estado persistido + el registro in-process (activeJobs) + una prueba de liveness/identidad
// de pid; nunca persiste ni envía señales. Proyección pura (sin fs); el escaneo I/O
// (listJobs/eachProjectRunDir/reconcileInterruptedJobs) queda en index.ts y alimenta esto.

import type { JobState } from "./index.js";
import { probeProcessAlive, verifyProcessIdentity } from "./process-liveness.js";
import { activeJobs, asNumber, asString } from "./runtime-state.js";

// Proyección read-time única del estado persistido (los únicos estados que un writer puede
// conocer: starting/running/completed/failed/cancelled). Cuando un job está persistido como
// starting/running pero esta sesión NO lo posee, prueba el pid registrado para distinguir un
// proceso huérfano pero vivo de uno que murió mientras Pi estaba caído, cayendo a `stale`
// solo cuando el pid no es comprobable. Nunca persistido, nunca señales: cancel sigue
// rechazando cualquier pid persistido.
export function projectState(
	jobId: string,
	persisted: string | undefined,
	pid: number | undefined,
): { state: JobState; persistedState?: string; hint?: string } {
	if ((persisted === "starting" || persisted === "running") && !activeJobs.has(jobId)) {
		return projectUnownedActiveState(persisted, pid);
	}
	return { state: (persisted ?? "unknown") as JobState };
}

function projectUnownedActiveState(
	persisted: "starting" | "running",
	pid: number | undefined,
): { state: JobState; persistedState?: string; hint?: string } {
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

export function deriveState(jobId: string, status: Record<string, unknown> | undefined): JobState {
	return projectState(jobId, asString(status?.state) ?? "unknown", asNumber(status?.pid)).state;
}

// Refina una proyección read-time `orphaned` con una prueba de identidad: una identidad de
// inicio distinta significa que el pid fue reutilizado (nuestro proceso terminó => interrupted);
// una identidad igual es verified-alive; unknown queda orphaned (mejor esfuerzo). Compartido por
// /bg status y classifyForDeletion para que ambos nunca diverjan.
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
