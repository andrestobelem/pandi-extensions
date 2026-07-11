import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolvePandiInput } from "./command-input.js";
import { nextFaceStyle } from "./face.js";
import { saveFaceStyle } from "./face-style-storage.js";
import { pandaFaces, pandaFrames } from "./indicator-frames.js";
import { MOODS, pick } from "./moods.js";
import type { PandiRuntime } from "./pandi-runtime.js";
import { applyPandiUi, restorePandiDefaults, setPandiSplash } from "./pandi-ui.js";

export async function handlePandiCommand(args: string, ctx: ExtensionContext, runtime: PandiRuntime): Promise<void> {
	const cmd = (await resolvePandiInput(args, ctx)).trim().toLowerCase();
	const f = pandaFaces(ctx.ui.theme);

	if (cmd === "off") {
		runtime.enabled = false;
		restorePandiDefaults(ctx);
		ctx.ui.notify(`${f.thinking} Pandi se fue a dormir (header y spinner default restaurados).`, "info");
		return;
	}

	if (cmd === "on") {
		runtime.enabled = true;
		applyPandiUi(ctx, runtime);
		ctx.ui.notify(`${f.happy} ¡Pandi volvió!`, "info");
		return;
	}

	const notifyAsleep = () => ctx.ui.notify(`${f.thinking} Pandi está dormido. Usá /pandi on primero.`, "info");

	if (cmd === "art") {
		if (!runtime.enabled) return notifyAsleep();
		runtime.artVisible = !runtime.artVisible;
		setPandiSplash(ctx, runtime);
		ctx.ui.notify(runtime.artVisible ? `${f.happy} Splash del panda activado.` : "Splash oculto.", "info");
		return;
	}

	if (cmd === "face") {
		if (!runtime.enabled) return notifyAsleep();
		runtime.faceStyle = nextFaceStyle(runtime.faceStyle);
		saveFaceStyle(runtime.faceStyle);
		const frames = pandaFrames(ctx.ui.theme, runtime.faceStyle);
		ctx.ui.setWorkingIndicator(frames);
		ctx.ui.notify(`${frames.frames?.[0] ?? ""} Estilo ${runtime.faceStyle} (guardado).`, "info");
		return;
	}

	applyPandiUi(ctx, runtime);
	ctx.ui.notify(
		runtime.enabled
			? `${f.happy} Pandi despierto y ${pick(MOODS)}`
			: `${f.thinking} Pandi dormido. Usá /pandi on para despertarlo.`,
		"info",
	);
}
