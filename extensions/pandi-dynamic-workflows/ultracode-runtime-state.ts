import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UltracodeRuntimeState = {
	getAlwaysOn: () => boolean;
	setAlwaysOn: (enabled: boolean) => void;
	getContractGateEnabled: () => boolean;
	setContractGateEnabled: (enabled: boolean) => void;
	getCurrentCtx: () => ExtensionContext | undefined;
	setCurrentCtx: (ctx: ExtensionContext | undefined) => void;
};

export function createUltracodeRuntimeState(): UltracodeRuntimeState {
	let alwaysOn = true;
	let contractGateEnabled = true;
	let currentCtx: ExtensionContext | undefined;

	return {
		getAlwaysOn: () => alwaysOn,
		setAlwaysOn: (enabled) => {
			alwaysOn = enabled;
		},
		getContractGateEnabled: () => contractGateEnabled,
		setContractGateEnabled: (enabled) => {
			contractGateEnabled = enabled;
		},
		getCurrentCtx: () => currentCtx,
		setCurrentCtx: (ctx) => {
			currentCtx = ctx;
		},
	};
}
