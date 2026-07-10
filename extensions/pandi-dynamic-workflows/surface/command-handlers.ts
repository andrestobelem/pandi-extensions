/**
 * Command/tool handlers — the dispatch bodies behind the dynamic_workflow tool and the
 * /workflow + /workflows commands. The thin glue between the activate registrations and
 * the engine / lifecycle / orchestration / ultracode layers.
 *
 * Fully-deferred cycle: every collaborator is called inside a handler body, so index.ts
 * imports the three entry points back and the activate body wires them into
 * registerTool/registerCommand. Imports filled in from the gate (typecheck + biome).
 * Extracted byte-identically.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "../lib/notify.js";
import { clearWorkflowWidget } from "../lifecycle/index.js";
import { openWorkflowDashboard } from "../tui/index.js";
import { handleBrowseWorkflowCommand } from "./command-browse.js";
import { handleLifecycleWorkflowCommand } from "./command-lifecycle.js";

export {
	type CleanupArgs,
	DEFAULT_CLEANUP_KEEP,
	DEFAULT_CLEANUP_OLDER_THAN_MS,
	parseCleanupArgs,
	parseRunReportArgs,
	type RunReportCommandArgs,
} from "./command-parsers.js";
export { handleTool } from "./tool-handler.js";

export async function handleWorkflowCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const trimmed = args.trim();
	const actionMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	const action = (actionMatch?.[1] || "list").toLowerCase();
	const afterAction = actionMatch?.[2]?.trimStart() ?? "";
	const nameMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(afterAction);
	const commandName = nameMatch?.[1];
	const trailingText = nameMatch?.[2] ?? "";
	const parsed = { action, afterAction, commandName, trailingText };

	try {
		if (await handleBrowseWorkflowCommand(pi, ctx, parsed)) return;
		if (await handleLifecycleWorkflowCommand(pi, ctx, parsed)) return;

		notify(
			ctx,
			"Usage: /workflow list | dashboard | agents | sessions | patterns | graph <name> | check <name> [json] | runs | view [latest|runId] | new <name> [--pattern=<key>] | edit <name> | run <name> [json] | start <name> [json] | resume [latest|runId] [--force] | cancel [latest|runId] | cleanup [sessions|runs|drafts|tmp|all] [--keep=N] [--older-than=24h] [--all-stale] [--dry-run] [--yes] | delete-run [latest|runId] | delete <name>",
			"warning",
		);
	} catch (err) {
		clearWorkflowWidget(ctx);
		notify(ctx, err instanceof Error ? err.message : String(err), "error");
	}
}

export async function handleWorkflowsCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	if (args.trim()) {
		await handleWorkflowCommand(pi, args, ctx);
		return;
	}
	await openWorkflowDashboard(pi, ctx);
}
