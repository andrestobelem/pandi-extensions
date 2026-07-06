import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { handleWorkflowCommand, handleWorkflowsCommand } from "./command-handlers.js";
import { openWorkflowDashboard } from "./dashboard-orchestration.js";
import { resolveWorkflowMenu } from "./workflow-menu.js";

export function registerWorkflowShellCommands(pi: ExtensionAPI): void {
	pi.registerCommand("workflow", {
		description:
			"Manage dynamic workflows: /workflow list|index|dashboard|agents|sessions|patterns|graph|runs|view|new|edit|run|start|resume|cancel|cleanup|delete-run|delete",
		handler: async (args, ctx) => await handleWorkflowCommand(pi, await resolveWorkflowMenu(args, ctx), ctx),
	});

	pi.registerCommand("workflows", {
		description: "Open the dynamic workflows dashboard (or pass through to /workflow, e.g. /workflows agents)",
		handler: async (args, ctx) => await handleWorkflowsCommand(pi, args, ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("w"), {
		description: "Open dynamic workflows dashboard",
		handler: async (ctx) => await openWorkflowDashboard(pi, ctx),
	});
}
