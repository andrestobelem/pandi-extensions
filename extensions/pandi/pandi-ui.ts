import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLAUDE_ORANGE, fgAnsi } from "./face.js";
import { pandaFrames } from "./indicator-frames.js";
import type { PandiRuntime } from "./pandi-runtime.js";
import { splashLines } from "./splash.js";

const STATUS_KEY = "pandi";
const ORANGE = fgAnsi(CLAUDE_ORANGE);
const RESET_FG = "\x1b[39m";
const orange = (s: string) => `${ORANGE}${s}${RESET_FG}`;

export function setPandiSplash(ctx: ExtensionContext, runtime: PandiRuntime): void {
	ctx.ui.setHeader(
		runtime.artVisible && runtime.enabled
			? (_tui, theme) => ({
					render: () => splashLines(theme),
					invalidate: () => {},
				})
			: undefined,
	);
}

export function applyPandiUi(ctx: ExtensionContext, runtime: PandiRuntime): void {
	if (!runtime.enabled) return;
	ctx.ui.setWorkingIndicator(pandaFrames(ctx.ui.theme, runtime.faceStyle));
	ctx.ui.setStatus(STATUS_KEY, `${orange("◆")} ${ctx.ui.theme.fg("accent", "Pandi")}`);
	setPandiSplash(ctx, runtime);
}

export function restorePandiDefaults(ctx: ExtensionContext): void {
	ctx.ui.setWorkingIndicator();
	ctx.ui.setWorkingMessage();
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setHeader(undefined);
}
