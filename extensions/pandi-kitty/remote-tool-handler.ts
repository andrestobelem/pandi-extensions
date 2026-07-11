import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	runCloseWindow,
	runFocusWindow,
	runGotoLayout,
	runKitty,
	runLaunch,
	type SplitLocation,
	type WindowType,
} from "./kitty.js";
import { buildKittyOpts } from "./kitty-options.js";
import { toolError, toToolResult } from "./tool-results.js";

export type KittyRemoteParams = {
	action: "launch" | "goto-layout" | "close-window" | "focus-window";
	type?: WindowType;
	location?: SplitLocation;
	layout?: string;
	matchId?: string;
};

export async function executeKittyRemote(
	params: KittyRemoteParams,
	ctx: ExtensionContext,
	signal: AbortSignal | null | undefined,
) {
	const opts = buildKittyOpts(ctx.cwd, signal);
	switch (params.action) {
		case "launch":
			return toToolResult(
				await runLaunch(runKitty, { type: params.type ?? "tab", location: params.location }, opts),
			);
		case "goto-layout":
			return toToolResult(await runGotoLayout(runKitty, { layout: params.layout ?? "" }, opts));
		case "close-window":
			return toToolResult(await runCloseWindow(runKitty, { matchId: params.matchId }, opts));
		case "focus-window":
			return toToolResult(await runFocusWindow(runKitty, { matchId: params.matchId ?? "" }, opts));
		default:
			return toolError(`Acción desconocida: ${(params as { action: string }).action}`);
	}
}
