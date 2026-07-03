/**
 * Pure presentation helpers for the dynamic-workflows UI: the small,
 * side-effect-free formatters that turn workflow data into display strings
 * (workflow list, progress counts, dashboard hint, short name, elapsed time).
 *
 * Depth-one sibling under extensions/pi-dynamic-workflows; bundled into index.ts
 * (jiti at runtime, esbuild in tests). The only coupling back to index.ts is
 * TYPE-only (WorkflowFile, WorkflowLogEntry) via `import type`, which is erased
 * at build time, so there is no runtime import cycle.
 *
 * NOTE: formatRunSummary and the getRun* run-state helpers stay in index.ts on
 * purpose — they depend on index internals (getRunStatusLabel, formatParallelAgents,
 * stringify, getRunState, WorkflowRunRecord), so they are not pure leaves.
 */

import { stringify } from "./format.js";
import type { WorkflowFile, WorkflowLogEntry } from "./index.js";

export function compactInline(value: unknown, maxChars = 160): string {
	return stringify(value, maxChars).replace(/\s+/g, " ").trim();
}

export function formatWorkflowList(files: WorkflowFile[]): string {
	if (files.length === 0) {
		return "No workflows found. Create one with `/workflow new <name>` or dynamic_workflow action=write.";
	}
	return files.map((file) => `- ${file.name} (${file.scope}) — ${file.relativePath}`).join("\n");
}

/** Auto-derived progress of the CURRENT agents() batch ("¿por dónde va?"). */
export interface WorkflowBatchProgress {
	label: string;
	done: number;
	started: number;
	total: number;
}

export interface WorkflowProgressCounts {
	agentsStarted: number;
	agentsDone: number;
	agentsRunning: number;
	bashDone: number;
	/** Present when the run's agents came from agents() (phase fields on the log details). */
	batch?: WorkflowBatchProgress;
}

export function workflowProgress(logs: WorkflowLogEntry[]): WorkflowProgressCounts {
	let agentsStarted = 0;
	let agentsDone = 0;
	let bashDone = 0;
	// agents() threads AgentPhaseInfo per item and both `agent N start:`/`agent N end:`
	// log details carry {phaseId, phaseIndex, phaseTotal, phaseLabel}. Aggregate per
	// phaseId so the CURRENT batch (highest id) can report done/total — done over the
	// batch TOTAL, not over started (done/started reads "5/5" while 11 of 16 items
	// have not even started).
	const phases = new Map<number, WorkflowBatchProgress>();
	for (const logEntry of logs) {
		const isStart = /^agent \d+ start:/.test(logEntry.message);
		const isEnd = /^agent \d+ end:/.test(logEntry.message);
		if (isStart) agentsStarted++;
		if (isEnd) agentsDone++;
		if (logEntry.message.startsWith("bash end:")) bashDone++;
		if (!isStart && !isEnd) continue;
		const details = logEntry.details as Record<string, unknown> | undefined;
		const phaseId = typeof details?.phaseId === "number" ? details.phaseId : undefined;
		const phaseTotal = typeof details?.phaseTotal === "number" ? details.phaseTotal : undefined;
		if (phaseId === undefined || phaseTotal === undefined || phaseTotal <= 0) continue;
		const entry = phases.get(phaseId) ?? {
			label:
				typeof details?.phaseLabel === "string" && details.phaseLabel.trim()
					? details.phaseLabel.trim()
					: `agents-${phaseId}`,
			done: 0,
			started: 0,
			total: phaseTotal,
		};
		if (isStart) entry.started++;
		else entry.done++;
		entry.total = phaseTotal;
		phases.set(phaseId, entry);
	}
	let batch: WorkflowBatchProgress | undefined;
	if (phases.size > 0) {
		const currentId = Math.max(...phases.keys());
		const current = phases.get(currentId);
		if (current) batch = { ...current };
	}
	return {
		agentsStarted,
		agentsDone,
		agentsRunning: Math.max(0, agentsStarted - agentsDone),
		bashDone,
		...(batch ? { batch } : {}),
	};
}

/**
 * Human text for the status line / monitor header: prefers the semantic batch
 * ("Review 5/16") over the legacy done/started fallback ("1/2"); "" when idle.
 */
export function workflowProgressLabel(progress: WorkflowProgressCounts): string {
	if (progress.batch) return `${progress.batch.label} ${progress.batch.done}/${progress.batch.total}`;
	return progress.agentsStarted > 0 ? `${progress.agentsDone}/${progress.agentsStarted}` : "";
}

export function workflowDashboardHint(): string {
	return "/workflows ↓ monitor ← agents Ctrl+Alt+W";
}

export function shortWorkflowName(name: string): string {
	return name.length <= 36 ? name : `${name.slice(0, 33)}…`;
}

export function formatElapsedMs(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}
