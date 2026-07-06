import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUltracodeInputEvents } from "./ultracode-input-events.js";
import { registerUltracodeModeEvent } from "./ultracode-mode-event.js";
import { createUltracodeRuntimeState } from "./ultracode-runtime-state.js";
import { registerUltracodeToggleCommands } from "./ultracode-toggle-commands.js";
import { registerWorkflowRoutingCommands } from "./workflow-routing-commands.js";
import { registerWorkflowSessionEvents } from "./workflow-session-events.js";
import { registerWorkflowShellCommands } from "./workflow-shell-commands.js";
import { registerDynamicWorkflowTool } from "./workflow-tool-registration.js";

export function activateDynamicWorkflowsExtension(pi: ExtensionAPI): void {
	const ultracodeState = createUltracodeRuntimeState();

	registerUltracodeModeEvent(pi, ultracodeState);

	registerDynamicWorkflowTool(pi);

	registerWorkflowShellCommands(pi);

	registerWorkflowRoutingCommands(pi, ultracodeState.getContractGateEnabled);
	registerUltracodeToggleCommands(pi, ultracodeState);
	registerUltracodeInputEvents(pi, ultracodeState);
	registerWorkflowSessionEvents(pi, ultracodeState);
}
