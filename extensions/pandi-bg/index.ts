/**
 * Jobs en segundo plano locales de `/bg` (M2a).
 *
 * El alcance es deliberadamente estrecho: solo slash commands humanas, runner local
 * con child_process, inicios solo en proyectos confiables, sin runner de Supacode y
 * sin tool LLM mutante.
 *
 * Arquitectura (modularizada al estilo pandi-plan):
 * - listado/resolución en job-listing.ts
 * - reconcile al session_start en reconcile.ts
 * - subcomandos en command-handlers.ts (+ command-{shared,lifecycle,query,cleanup}.ts)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BG_ARGUMENT_COMPLETIONS, canRunInMode, handleBgCommand, notifyBg } from "./command-handlers.js";
import { reconcileInterruptedJobs } from "./reconcile.js";

// El ciclo de vida de child-process + log-stream vive en ./job-runtime.ts; se reexportan
// porque la suite de integración los importa desde el bundle generado.
export {
	finalizeJob,
	guardStreamErrors,
	isJobFinished,
	pipeWithBackpressure,
	safeFinalize,
	writeStatus,
} from "./job-runtime.js";
export { probeProcessAlive, readProcessStartId, verifyProcessIdentity } from "./process-liveness.js";
export { reconcileInterruptedJobs } from "./reconcile.js";
export { atomicWriteJson, dirSizeBytes, parsePruneFlags, removeRunDir } from "./storage.js";
export type { JobState, JobStatus, RuntimeJob } from "./types.js";

export default function bgExtension(pi: ExtensionAPI): void {
	pi.registerCommand("bg", {
		description:
			"Jobs en segundo plano: /bg preview <command> | /bg start <command> | /bg cancel <jobId> | /bg list | /bg status <jobId> | /bg logs <jobId> | /bg events <jobId> | /bg delete <jobId> | /bg prune [--yes]",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!prefix) return BG_ARGUMENT_COMPLETIONS;
			return BG_ARGUMENT_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => notifyBg(ctx, await handleBgCommand(args, ctx)),
	});

	// Self-heal al startup (solo sesiones persistentes y confiables, donde se poseen jobs):
	// reescribe jobs locales del proyecto cuyo pid registrado está muerto, de `running` stale
	// a `interrupted` terminal, para que el artifact en disco deje de afirmar `running`.
	// Mejor esfuerzo; nunca dejar que rompa session start.
	pi.on("session_start", async (_event, ctx) => {
		if (!canRunInMode(ctx)) return;
		try {
			await reconcileInterruptedJobs(ctx);
		} catch {
			// ignore: reconcile es bookkeeping no crítico
		}
	});
}
