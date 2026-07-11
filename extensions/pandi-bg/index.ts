/**
 * Jobs en segundo plano locales de `/bg` (M2a).
 *
 * Arquitectura (modularizada al estilo pandi-plan):
 * - listado/resolución en job-listing.ts
 * - reconcile al session_start en session-hooks.ts
 * - subcomandos en command-handlers.ts (+ command-{shared,lifecycle,query,cleanup}.ts)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBgCommand } from "./command-handlers.js";
import { registerBgSessionHooks } from "./session-hooks.js";

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
	registerBgCommand(pi);
	registerBgSessionHooks(pi);
}
