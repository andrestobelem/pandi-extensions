import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import "./lifecycle/runtime-deps.js";
import {
	registerDynamicWorkflowTool,
	registerWorkflowRoutingCommands,
	registerWorkflowShellCommands,
} from "./surface/index.js";
import {
	createUltracodeRuntimeState,
	registerUltracodeInputEvents,
	registerUltracodeModeEvent,
	registerUltracodeToggleCommands,
} from "./ultracode/index.js";
import { registerWorkflowSessionEvents } from "./workflow-session-events.js";

export function dynamicWorkflowsExtension(pi: ExtensionAPI): void {
	const ultracodeState = createUltracodeRuntimeState();

	registerUltracodeModeEvent(pi, ultracodeState);

	registerDynamicWorkflowTool(pi);

	registerWorkflowShellCommands(pi);

	registerWorkflowRoutingCommands(pi, ultracodeState.getContractGateEnabled);
	registerUltracodeToggleCommands(pi, ultracodeState);
	registerUltracodeInputEvents(pi, ultracodeState);
	registerWorkflowSessionEvents(pi, ultracodeState);
}
