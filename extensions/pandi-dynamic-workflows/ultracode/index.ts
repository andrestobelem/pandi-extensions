/**
 * Fachada del deep module `ultracode` — routing always-on, contract-gate, toggles y status UI.
 * Call sites externos importan desde aquí; el interior (router, events, state) queda escondido.
 */

export { registerUltracodeInputEvents } from "./input-events.js";
export { registerUltracodeModeEvent } from "./mode-event.js";
export {
	clearUltracodeContractGateStatus,
	clearUltracodeStatus,
	dynamicWorkflowToolAvailable,
	ensureDynamicWorkflowToolActive,
	extractUltracodeTask,
	isGeneratedUltracodePrompt,
	makeAlwaysOnUltracodeSystemPrompt,
	makeUltracodePrompt,
	parseToggleCommandValue,
	resolveUltracodeModeValue,
	sendWorkflowPrompt,
	setUltracodeContractGateStatus,
	setUltracodeStatus,
} from "./router.js";
export { createUltracodeRuntimeState, type UltracodeRuntimeState } from "./runtime-state.js";
export { registerUltracodeToggleCommands } from "./toggle-commands.js";
