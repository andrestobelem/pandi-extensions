import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLimits, limitParamsFromInput, parseCliJsonOrText } from "../lib/config.js";
import { notify } from "../lib/notify.js";
import { formatRunSummary } from "../lib/run-summary.js";
import {
	cancelWorkflowRun,
	cleanupWorkflowDrafts,
	cleanupWorkflowRuns,
	cleanupWorkflowTmp,
	deleteWorkflowRun,
	formatBackgroundStart,
	formatCleanupInventory,
	inventoryWorkflowRuns,
	shouldLaunchWorkflowInBackground,
	startWorkflowBackground,
} from "../lifecycle/index.js";
import { prunePiSessionFiles } from "../pi-session.js";
import { getRunStatusLabel, resolveRun } from "../runtime/index.js";
import { canCancelRun, runWorkflowWithUi, showText } from "../tui/index.js";
import type { WorkflowLogEntry } from "../types.js";
import { resumeWorkflowForCaller } from "../workflow-resume-usecase.js";
import type { WorkflowCommandParsed } from "./command-browse.js";
import { parseCleanupArgs } from "./command-parsers.js";
import { resolveWorkflow } from "./resolve.js";

/** Returns true if the action was handled. */
export async function handleLifecycleWorkflowCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	parsed: WorkflowCommandParsed,
): Promise<boolean> {
	const { action, afterAction, commandName, trailingText } = parsed;

	if (action === "run") {
		const name = commandName;
		if (!name) {
			notify(ctx, "Usage: /workflow run <name> [json-input]", "warning");
			return true;
		}
		const jsonText = trailingText.trim();
		const input = parseCliJsonOrText(jsonText);
		const workflow = await resolveWorkflow(ctx, name, "auto");
		const limits = buildLimits(limitParamsFromInput(input));
		if (shouldLaunchWorkflowInBackground(ctx)) {
			const status = await startWorkflowBackground(pi, ctx, workflow, input, limits);
			notify(ctx, formatBackgroundStart(status), "info");
			return true;
		}
		let lastLogs: WorkflowLogEntry[] = [];
		const result = await runWorkflowWithUi(pi, ctx, workflow, input, limits, undefined, (logs) => {
			lastLogs = logs;
		});
		notify(ctx, formatRunSummary(result), result.ok ? "info" : "error");
		if (lastLogs.length === 0) notify(ctx, "Workflow produced no logs.", "warning");
		return true;
	}

	if (action === "start" || action === "bg" || action === "background") {
		const name = commandName;
		if (!name) {
			notify(ctx, "Usage: /workflow start <name> [json-input]", "warning");
			return true;
		}
		const jsonText = trailingText.trim();
		const input = parseCliJsonOrText(jsonText);
		const workflow = await resolveWorkflow(ctx, name, "auto");
		const limits = buildLimits(limitParamsFromInput(input));
		const status = await startWorkflowBackground(pi, ctx, workflow, input, limits);
		notify(ctx, formatBackgroundStart(status), "info");
		return true;
	}

	if (action === "resume") {
		// Tokens después de "resume": <runId> opcional (por defecto es el más reciente) más
		// --force. Las sesiones persistentes se reanudan en segundo plano por defecto; print/json
		// retrocede a primer plano porque ninguna ejecución en segundo plano puede permanecer viva.
		const tokens = afterAction.split(/\s+/).filter(Boolean);
		const force = tokens.some((t) => t === "--force" || t === "-f");
		const runId = tokens.find((t) => !t.startsWith("-"));
		const presentation = await resumeWorkflowForCaller(pi, ctx, runId, { force });
		if (presentation.kind === "background") {
			notify(ctx, presentation.message, "info");
		} else {
			notify(ctx, presentation.message, presentation.ok ? "info" : "error");
		}
		return true;
	}

	if (action === "cancel" || action === "stop") {
		const message = await cancelWorkflowRun(ctx, commandName);
		notify(ctx, message, "warning");
		return true;
	}

	if (action === "cleanup" || action === "prune" || action === "gc") {
		const opts = parseCleanupArgs(afterAction);
		const doSessions = opts.target === "sessions" || opts.target === "both" || opts.target === "all";
		const doRuns = opts.target === "runs" || opts.target === "both" || opts.target === "all";
		const doDrafts = opts.target === "drafts" || opts.target === "all";
		const doTmp = opts.target === "tmp" || opts.target === "all";

		// Dry-run: previsualiza a través de los selectores puros sin eliminar nada.
		if (opts.dryRun) {
			const lines = ["/workflow cleanup --dry-run — nothing was deleted."];
			if (doSessions) {
				const preview = await prunePiSessionFiles(ctx, {
					includeHeartbeatStale: opts.includeHeartbeatStale,
					dryRun: true,
				});
				lines.push(`Stale session files to remove: ${preview.removed.length} (keeping ${preview.kept})`);
				for (const item of preview.items) {
					lines.push(`  - sessions ${item.action}: ${item.file} — ${item.reason}`);
				}
			}
			if (doRuns) {
				const runItems = await inventoryWorkflowRuns(ctx, { keep: opts.keep });
				const removed = runItems.filter((item) => item.action === "delete").length;
				lines.push(`Terminal runs to remove: ${removed} (keeping ${runItems.length - removed}, keep=${opts.keep})`);
				lines.push(...formatCleanupInventory(runItems));
			}
			if (doDrafts) {
				const preview = await cleanupWorkflowDrafts(ctx, { olderThanMs: opts.olderThanMs, dryRun: true });
				lines.push(`Draft files to remove: ${preview.removed.length} (keeping ${preview.kept})`);
				lines.push(...formatCleanupInventory(preview.items));
			}
			if (doTmp) {
				const preview = await cleanupWorkflowTmp(ctx, { olderThanMs: opts.olderThanMs, dryRun: true });
				lines.push(`Tmp entries to remove: ${preview.removed.length} (keeping ${preview.kept})`);
				lines.push(...formatCleanupInventory(preview.items));
			}
			await showText(ctx, "Workflow cleanup (dry run)", lines.join("\n"));
			return true;
		}

		// Destructivo: requiere confirmación interactiva, o un --yes explícito en modo sin UI.
		if (!ctx.hasUI && !opts.yes) {
			notify(ctx, "/workflow cleanup is destructive; pass --yes (or --dry-run) in no-UI mode.", "warning");
			return true;
		}
		if (ctx.hasUI && !opts.yes) {
			const scope = [
				doSessions ? "stale session files" : "",
				doRuns ? `terminal runs (keep last ${opts.keep})` : "",
				doDrafts ? `old unused drafts (older than ${Math.round(opts.olderThanMs / 3_600_000)}h)` : "",
				doTmp ? `old .pi/tmp entries (older than ${Math.round(opts.olderThanMs / 3_600_000)}h)` : "",
			]
				.filter(Boolean)
				.join(" and ");
			const ok = await ctx.ui.confirm(
				"Run workflow cleanup?",
				`This permanently deletes ${scope}${opts.includeHeartbeatStale ? " (including heartbeat-stale sessions)" : ""}.\n\nActive runs and the current session are never touched. Use --dry-run to preview.`,
			);
			if (!ok) return true;
		}

		const summary: string[] = [];
		if (doSessions) {
			const res = await prunePiSessionFiles(ctx, { includeHeartbeatStale: opts.includeHeartbeatStale });
			summary.push(`Removed ${res.removed.length} stale session file(s); kept ${res.kept}.`);
		}
		if (doDrafts) {
			// Draft usage is derived from the current run store. Run draft cleanup before run cleanup so
			// `cleanup all` cannot cascade from "delete old runs" into "now this draft looks unused".
			const res = await cleanupWorkflowDrafts(ctx, { olderThanMs: opts.olderThanMs });
			summary.push(`Removed ${res.removed.length} old unused draft file(s); kept ${res.kept}.`);
		}
		if (doRuns) {
			const res = await cleanupWorkflowRuns(ctx, { keep: opts.keep });
			summary.push(`Removed ${res.removed.length} terminal run(s); kept ${res.kept} (keep=${opts.keep}).`);
		}
		if (doTmp) {
			const res = await cleanupWorkflowTmp(ctx, { olderThanMs: opts.olderThanMs });
			summary.push(`Removed ${res.removed.length} old tmp entr(y/ies); kept ${res.kept}.`);
		}
		notify(ctx, summary.join("\n"), "info");
		return true;
	}

	if (action === "delete-run" || action === "rm-run" || action === "delete-run-artifacts") {
		const run = await resolveRun(ctx, commandName);
		if (canCancelRun(run)) {
			notify(ctx, `Run is still active; cancel it before deleting artifacts: ${run.runId}`, "warning");
			return true;
		}
		if (!ctx.hasUI) {
			notify(ctx, "/workflow delete-run requires interactive confirmation; refusing in no-UI mode.", "warning");
			return true;
		}
		const ok = await ctx.ui.confirm(
			"Delete workflow run artifacts?",
			`Workflow: ${run.workflow}\nRun: ${run.runId}\nState: ${getRunStatusLabel(run)}\nDirectory: ${run.runDir}\n\nThis permanently deletes this run directory and its artifacts. The workflow file is not deleted.`,
		);
		if (!ok) return true;
		const message = await deleteWorkflowRun(ctx, run.runId);
		notify(ctx, message, "warning");
		return true;
	}

	if (action === "delete" || action === "rm") {
		const name = commandName;
		if (!name) {
			notify(ctx, "Usage: /workflow delete <name>", "warning");
			return true;
		}
		const workflow = await resolveWorkflow(ctx, name, "auto");
		if (!ctx.hasUI) {
			notify(ctx, "/workflow delete requires interactive confirmation; refusing in no-UI mode.", "warning");
			return true;
		}
		const ok = await ctx.ui.confirm("Delete workflow?", `${workflow.name}\n${workflow.path}`);
		if (!ok) return true;
		await fs.unlink(workflow.path);
		notify(ctx, `Deleted ${workflow.path}`, "info");
		return true;
	}

	return false;
}
