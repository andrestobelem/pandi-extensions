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

export function workflowProgress(logs: WorkflowLogEntry[]): {
	agentsStarted: number;
	agentsDone: number;
	agentsRunning: number;
	bashDone: number;
} {
	let agentsStarted = 0;
	let agentsDone = 0;
	let bashDone = 0;
	for (const logEntry of logs) {
		if (/^agent \d+ start:/.test(logEntry.message)) agentsStarted++;
		if (/^agent \d+ end:/.test(logEntry.message)) agentsDone++;
		if (logEntry.message.startsWith("bash end:")) bashDone++;
	}
	return {
		agentsStarted,
		agentsDone,
		agentsRunning: Math.max(0, agentsStarted - agentsDone),
		bashDone,
	};
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
