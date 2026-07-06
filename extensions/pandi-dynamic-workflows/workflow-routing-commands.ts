import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "./notify.js";
import { ensureDynamicWorkflowToolActive, makeUltracodePrompt, sendWorkflowPrompt } from "./ultracode.js";

type WorkflowRoutingPromptMode = "ultracode" | "deep-research";

function makeWorkflowRoutingHandler(
	pi: ExtensionAPI,
	commandName: string,
	contractGateEnabled: () => boolean,
	options: { promptMode?: WorkflowRoutingPromptMode; usageTarget?: string } = {},
) {
	const promptMode = options.promptMode ?? "ultracode";
	const usageTarget = options.usageTarget ?? "<task>";
	return async (args: string, ctx: ExtensionContext) => {
		const task = args.trim();
		if (!task) {
			notify(ctx, `Usage: /${commandName} ${usageTarget}`, "warning");
			return;
		}
		if (!ensureDynamicWorkflowToolActive(pi))
			notify(
				ctx,
				`dynamic_workflow tool is not active; ${commandName} will only provide routing guidance.`,
				"warning",
			);
		sendWorkflowPrompt(pi, ctx, makeUltracodePrompt(task, promptMode, contractGateEnabled()));
	};
}

export function registerWorkflowRoutingCommands(pi: ExtensionAPI, contractGateEnabled: () => boolean): void {
	pi.registerCommand("dynamic-workflow", {
		description: "Ask Pi to solve a complex task using dynamic workflows when warranted",
		handler: makeWorkflowRoutingHandler(pi, "dynamic-workflow", contractGateEnabled),
	});

	pi.registerCommand("ultracode", {
		description: "Alias for /dynamic-workflow: solve a complex task using dynamic workflows when warranted",
		handler: makeWorkflowRoutingHandler(pi, "ultracode", contractGateEnabled),
	});

	pi.registerCommand("deep-research", {
		description: "Ask Pi to create/run a dynamic workflow for deep research",
		handler: makeWorkflowRoutingHandler(pi, "deep-research", contractGateEnabled, {
			promptMode: "deep-research",
			usageTarget: "<research question>",
		}),
	});
}
