import { DEFAULT_CLEANUP_KEEP } from "../lifecycle/index.js";

// Re-exported from lifecycle/index.ts (single source of truth for the retention default) so
// the CLI parser and its test can reference it without reaching across modules.
export { DEFAULT_CLEANUP_KEEP };

export const DEFAULT_CLEANUP_OLDER_THAN_MS = 24 * 60 * 60 * 1000;

export interface CleanupArgs {
	target: "sessions" | "runs" | "drafts" | "tmp" | "both" | "all";
	keep: number;
	olderThanMs: number;
	includeHeartbeatStale: boolean;
	dryRun: boolean;
	yes: boolean;
}

function parseCleanupDurationMs(raw: string): number | undefined {
	const match = /^(\d+)([mhd])$/.exec(raw.trim());
	if (!match) return undefined;
	const value = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isFinite(value)) return undefined;
	const unit = match[2];
	if (unit === "m") return value * 60 * 1000;
	if (unit === "h") return value * 60 * 60 * 1000;
	return value * 24 * 60 * 60 * 1000;
}

// Pure parser for `/workflow cleanup [sessions|runs|drafts|tmp|both|all] [--keep=N] [--older-than=24h] [--all-stale] [--dry-run|-n] [--yes|-y]`.
// Order-independent; unknown tokens are ignored (target stays "both"). Safe defaults: sessions+runs,
// keep the DEFAULT_CLEANUP_KEEP most-recent runs, leave heartbeat-stale sessions, use a 24h age
// threshold for drafts/tmp, and neither preview nor auto-confirm.
export function parseCleanupArgs(afterAction: string): CleanupArgs {
	const result: CleanupArgs = {
		target: "both",
		keep: DEFAULT_CLEANUP_KEEP,
		olderThanMs: DEFAULT_CLEANUP_OLDER_THAN_MS,
		includeHeartbeatStale: false,
		dryRun: false,
		yes: false,
	};
	for (const token of afterAction.trim().split(/\s+/).filter(Boolean)) {
		if (token === "sessions" || token === "session") result.target = "sessions";
		else if (token === "runs" || token === "run") result.target = "runs";
		else if (token === "drafts" || token === "draft") result.target = "drafts";
		else if (token === "tmp" || token === "temp") result.target = "tmp";
		else if (token === "both") result.target = "both";
		else if (token === "all") result.target = "all";
		else if (token === "--all-stale") result.includeHeartbeatStale = true;
		else if (token === "--dry-run" || token === "-n") result.dryRun = true;
		else if (token === "--yes" || token === "-y") result.yes = true;
		else if (token.startsWith("--keep=")) {
			const value = Number.parseInt(token.slice("--keep=".length), 10);
			if (Number.isFinite(value)) result.keep = Math.max(0, value);
		} else if (token.startsWith("--older-than=")) {
			const value = parseCleanupDurationMs(token.slice("--older-than=".length));
			if (value !== undefined) result.olderThanMs = value;
		}
	}
	return result;
}

export interface RunReportCommandArgs {
	runId?: string;
	outPath?: string;
	watch: boolean;
	missingOutPath: boolean;
}

export function parseRunReportArgs(afterAction: string): RunReportCommandArgs {
	const tokens = afterAction.split(/\s+/).filter(Boolean);
	const result: RunReportCommandArgs = { watch: false, missingOutPath: false };
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--watch") {
			result.watch = true;
			continue;
		}
		if (token === "-o" || token === "--out") {
			const next = tokens[i + 1];
			if (!next || next.startsWith("-")) {
				result.missingOutPath = true;
				continue;
			}
			result.outPath = next;
			i++;
			continue;
		}
		if (!token.startsWith("-") && result.runId === undefined) result.runId = token;
	}
	if (result.runId === "latest") result.runId = undefined;
	return result;
}
