import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeWorkflowPromptGuidelines, workflowToolSchema } from "./workflow-tool-contract.js";
import { handleTool } from "./workflow-tool-handler.js";

export function registerDynamicWorkflowTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "dynamic_workflow",
		label: "Dynamic Workflow",
		description:
			"Create, manage, and run Claude-style dynamic workflows: JavaScript orchestration scripts that can spawn parallel Pi subagents and store artifacts outside chat context.",
		promptSnippet: "Create/list/read/write/run/start JavaScript workflows that orchestrate parallel Pi subagents.",
		promptGuidelines: makeWorkflowPromptGuidelines(),
		parameters: workflowToolSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return await handleTool(pi, params, signal, onUpdate, ctx);
		},
	});
}
