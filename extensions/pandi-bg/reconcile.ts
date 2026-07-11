/**
 * Self-heal al session-start: jobs persistidos como starting/running cuyo pid murió.
 */

import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { eachProjectRunDir } from "./job-listing.js";
import { probeProcessAlive, verifyProcessIdentity } from "./process-liveness.js";
import { activeJobs, appendEvent, asNumber, asString, nowIso } from "./runtime-state.js";
import { atomicWriteJson } from "./storage.js";

const RECONCILABLE_STATES = new Set(["starting", "running"]);

// Self-heal al session-start: un proceso Pi nuevo no posee jobs (activeJobs está vacío),
// así que todo job local del proyecto persistido como starting/running viene de una corrida
// anterior. Se prueba su pid registrado; un pid DEAD significa que el proceso ya no existe
// (Pi murió antes de finalize), así que el artifact se reescribe atómicamente a un estado
// terminal `interrupted`. Los jobs vivos/no comprobables quedan intactos (la proyección
// read-time aún muestra orphaned/stale). Escribir `interrupted` solo con un pid confirmado
// muerto evita el riesgo de reutilización de pid: un pid muerto nunca puede ser nuestro job
// vivo, así que el estado terminal siempre es correcto. Solo project root (la única root que
// escribe pandi-bg, y solo cuando es confiable); mejor esfuerzo, nunca lanza hacia
// session_start.
export async function reconcileInterruptedJobs(ctx: ExtensionContext): Promise<number> {
	let reconciled = 0;
	for (const { jobId, runDir, status } of await eachProjectRunDir(ctx)) {
		if (activeJobs.has(jobId)) continue;
		const state = asString(status?.state);
		if (!state || !RECONCILABLE_STATES.has(state)) continue;
		const pid = asNumber(status?.pid);
		const live = probeProcessAlive(pid);
		// Dead pid => proceso ausente. Alive pero con identidad de inicio distinta => el pid
		// fue reutilizado, así que nuestro proceso también terminó. Ambos son evidencia positiva
		// para terminalizar; un pid alive que no podemos descartar (same/unknown) queda como
		// orphaned/stale read-time.
		const cause =
			live === "dead"
				? "pid-dead"
				: live === "alive" && verifyProcessIdentity(pid, asString(status?.startId)) === "different"
					? "pid-reused"
					: undefined;
		if (!cause) continue;
		const now = nowIso();
		try {
			await atomicWriteJson(path.join(runDir, "status.json"), {
				...status,
				state: "interrupted",
				completedAt: now,
				updatedAt: now,
				reason: "session-start-reconcile",
			});
			await appendEvent(runDir, {
				event: "reconcile-interrupted",
				jobId,
				pid: pid ?? null,
				persistedState: state,
				cause,
			});
			reconciled++;
		} catch {
			// Mejor esfuerzo: deja el artifact intacto si falla la reescritura atómica.
		}
	}
	return reconciled;
}
