import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureDynamicWorkflowToolActive, setUltracodeStatus } from "./ultracode.js";

// Gancho inter-extensión de mejor esfuerzo usado por extensions/effort/index.ts para `/effort ultracode`.
const ULTRACODE_MODE_EVENT = "pandi-dynamic-workflows:ultracode-mode";

type UltracodeModeEventState = {
	setAlwaysOn: (enabled: boolean) => void;
	getCurrentCtx: () => ExtensionContext | undefined;
};

export function registerUltracodeModeEvent(pi: ExtensionAPI, state: UltracodeModeEventState): void {
	pi.events?.on?.(ULTRACODE_MODE_EVENT, (data) => {
		const request = data as { enabled?: unknown } | undefined;
		const enabled = request?.enabled !== false;
		state.setAlwaysOn(enabled);
		if (enabled) ensureDynamicWorkflowToolActive(pi);
		const currentCtx = state.getCurrentCtx();
		if (currentCtx) setUltracodeStatus(currentCtx, enabled);
	});
}
