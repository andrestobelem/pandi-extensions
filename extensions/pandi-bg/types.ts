/**
 * Declaraciones de tipos compartidas para la extensión `/bg`.
 *
 * Declaraciones puras de tipos/interfaces extraídas de index.ts (cero runtime).
 * El registro in-process, job-runtime y proyección de estado que USAN estos tipos
 * quedan en sus módulos; este archivo es una hoja sin imports de hermanos para
 * que cualquier módulo del paquete pueda depender de él sin ciclos.
 */

import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";

export type JobState =
	| "starting"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "orphaned"
	| "interrupted"
	| "stale"
	| "unknown";

export interface JobStatus {
	jobId: string;
	state: JobState;
	pid?: number;
	startId?: string;
	startedAt?: string;
	updatedAt: string;
	completedAt?: string;
	exitCode?: number | null;
	signal?: string | null;
	cancelRequested?: boolean;
	active?: boolean;
	persistedState?: string;
	error?: string;
}

export interface RuntimeJob {
	jobId: string;
	runDir: string;
	command: string;
	child: ChildProcess;
	status: JobStatus;
	stdoutStream: WriteStream;
	stderrStream: WriteStream;
	combinedStream: WriteStream;
	cancelTimer?: ReturnType<typeof setTimeout>;
	statusWriteChain?: Promise<void>;
	finalized: boolean;
}
