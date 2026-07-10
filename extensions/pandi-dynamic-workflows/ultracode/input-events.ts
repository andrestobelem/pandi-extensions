import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	dynamicWorkflowToolAvailable,
	ensureDynamicWorkflowToolActive,
	extractUltracodeTask,
	isGeneratedUltracodePrompt,
	makeAlwaysOnUltracodeSystemPrompt,
	makeUltracodePrompt,
} from "./router.js";

type UltracodeInputEventState = {
	getAlwaysOn: () => boolean;
	getContractGateEnabled: () => boolean;
};

export function registerUltracodeInputEvents(pi: ExtensionAPI, state: UltracodeInputEventState): void {
	pi.on("input", (event) => {
		if (event.source === "extension") return;
		const task = extractUltracodeTask(event.text);
		if (!task) return;
		ensureDynamicWorkflowToolActive(pi);
		return {
			action: "transform" as const,
			text: makeUltracodePrompt(task, "ultracode", state.getContractGateEnabled()),
			images: event.images,
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.getAlwaysOn()) return;
		if (isGeneratedUltracodePrompt(event.prompt)) return;
		if (
			!dynamicWorkflowToolAvailable(event.systemPromptOptions.selectedTools) &&
			!ensureDynamicWorkflowToolActive(pi)
		)
			return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${makeAlwaysOnUltracodeSystemPrompt(state.getContractGateEnabled())}`,
		};
	});
}
