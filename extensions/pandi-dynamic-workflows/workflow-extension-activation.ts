import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setWorkflowWidgetDeps } from "./lib/workflow-widget-deps.js";
import "./lifecycle/runtime-deps.js";
import { clearWorkflowWidget, setWorkflowWidget } from "./tui/workflow-widget.js";

setWorkflowWidgetDeps({ setWorkflowWidget, clearWorkflowWidget });

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
