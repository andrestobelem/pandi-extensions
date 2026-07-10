import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "../notify.js";
import {
	ensureDynamicWorkflowToolActive,
	parseToggleCommandValue,
	resolveUltracodeModeValue,
	setUltracodeContractGateStatus,
	setUltracodeStatus,
} from "./router.js";

type ToggleCommandHandlerOptions = {
	resolveValue?: (args: string, ctx: ExtensionContext) => string | Promise<string>;
	getEnabled: () => boolean;
	setEnabled: (enabled: boolean) => void;
	syncStatus: (ctx: ExtensionContext) => void;
	onEnable?: (ctx: ExtensionContext) => void;
	statusMessage: (enabled: boolean) => string;
	enabledMessage: string;
	disabledMessage: string;
	usage: string;
};

type UltracodeToggleState = {
	getContractGateEnabled: () => boolean;
	setContractGateEnabled: (enabled: boolean) => void;
	getAlwaysOn: () => boolean;
	setAlwaysOn: (enabled: boolean) => void;
};

function makeToggleCommandHandler(options: ToggleCommandHandlerOptions) {
	return async (args: string, ctx: ExtensionContext) => {
		const rawValue = options.resolveValue ? await options.resolveValue(args, ctx) : args;
		const value = parseToggleCommandValue(rawValue);
		if (value === "status") {
			options.syncStatus(ctx);
			notify(ctx, options.statusMessage(options.getEnabled()), "info");
			return;
		}
		if (value === "on") {
			options.setEnabled(true);
			options.onEnable?.(ctx);
			options.syncStatus(ctx);
			notify(ctx, options.enabledMessage, "info");
			return;
		}
		if (value === "off") {
			options.setEnabled(false);
			options.syncStatus(ctx);
			notify(ctx, options.disabledMessage, "warning");
			return;
		}
		notify(ctx, options.usage, "warning");
	};
}

export function registerUltracodeToggleCommands(pi: ExtensionAPI, state: UltracodeToggleState): void {
	pi.registerCommand("ultracode-contract", {
		description: "Show or toggle the Ultracode Contract Gate for this session",
		handler: makeToggleCommandHandler({
			getEnabled: state.getContractGateEnabled,
			setEnabled: state.setContractGateEnabled,
			syncStatus: (ctx) => setUltracodeContractGateStatus(ctx, state.getContractGateEnabled()),
			statusMessage: (enabled) => `Ultracode Contract Gate is ${enabled ? "enabled" : "disabled"}.`,
			enabledMessage:
				"Ultracode Contract Gate enabled: substantive workflow tasks will include task-contract review guidance.",
			disabledMessage: "Ultracode Contract Gate disabled for this session; workflow routing remains available.",
			usage: "Usage: /ultracode-contract [on|off|status]",
		}),
	});

	pi.registerCommand("ultracode-mode", {
		description: "Show or toggle always-on ultracode workflow routing for this session",
		handler: makeToggleCommandHandler({
			resolveValue: resolveUltracodeModeValue,
			getEnabled: state.getAlwaysOn,
			setEnabled: state.setAlwaysOn,
			syncStatus: (ctx) => setUltracodeStatus(ctx, state.getAlwaysOn()),
			onEnable: () => {
				ensureDynamicWorkflowToolActive(pi);
			},
			statusMessage: (enabled) => `Ultracode always-on is ${enabled ? "enabled" : "disabled"}.`,
			enabledMessage: "Ultracode always-on enabled: Pi will evaluate each task for workflow routing.",
			disabledMessage: "Ultracode always-on disabled for this session.",
			usage: "Usage: /ultracode-mode [on|off|status]",
		}),
	});
}
