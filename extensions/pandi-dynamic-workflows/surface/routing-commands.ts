import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "../notify.js";
import { ensureDynamicWorkflowToolActive, makeUltracodePrompt, sendWorkflowPrompt } from "../ultracode/index.js";

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
			notify(ctx, `Uso: /${commandName} ${usageTarget}`, "warning");
			return;
		}
		if (!ensureDynamicWorkflowToolActive(pi))
			notify(ctx, `La tool dynamic_workflow no está activa; ${commandName} solo dará guía de routing.`, "warning");
		sendWorkflowPrompt(pi, ctx, makeUltracodePrompt(task, promptMode, contractGateEnabled()));
	};
}

export function registerWorkflowRoutingCommands(pi: ExtensionAPI, contractGateEnabled: () => boolean): void {
	pi.registerCommand("dynamic-workflow", {
		description: "Pedile a Pi que resuelva una tarea compleja con dynamic workflows cuando valga la pena",
		handler: makeWorkflowRoutingHandler(pi, "dynamic-workflow", contractGateEnabled),
	});

	pi.registerCommand("ultracode", {
		description: "Alias de /dynamic-workflow: resolvé una tarea compleja con dynamic workflows cuando valga la pena",
		handler: makeWorkflowRoutingHandler(pi, "ultracode", contractGateEnabled),
	});

	pi.registerCommand("deep-research", {
		description: "Pedile a Pi que cree/corra un dynamic workflow para deep research",
		handler: makeWorkflowRoutingHandler(pi, "deep-research", contractGateEnabled, {
			promptMode: "deep-research",
			usageTarget: "<research question>",
		}),
	});
}
