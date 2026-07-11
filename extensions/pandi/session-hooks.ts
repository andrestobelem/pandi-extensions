import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pandaFaces } from "./indicator-frames.js";
import { GREETINGS, greetingText, MOODS, PANDI_QUOTE, pick } from "./moods.js";
import type { PandiRuntime } from "./pandi-runtime.js";
import { applyPandiUi } from "./pandi-ui.js";
import { pandiPersonaBlock } from "./persona.js";

export function handleSessionStart(ctx: ExtensionContext, runtime: PandiRuntime): void {
	applyPandiUi(ctx, runtime);
	if (!runtime.enabled) return;
	const f = pandaFaces(ctx.ui.theme);
	const greet = Math.random() < 0.1 ? f.gatuno : f.happy;
	ctx.ui.notify(`${greet} ${greetingText(runtime.artVisible, pick(GREETINGS))}`, "info");
}

export function handleBeforeAgentStart(event: { systemPrompt: string }, runtime: PandiRuntime) {
	if (!runtime.enabled) return;
	return { systemPrompt: `${event.systemPrompt}\n\n${pandiPersonaBlock()}` };
}

export function handleTurnStart(ctx: ExtensionContext, runtime: PandiRuntime): void {
	if (!runtime.enabled) return;
	const msg = Math.random() < 0.25 ? PANDI_QUOTE[0] : `Pandi ${pick(MOODS)}`;
	ctx.ui.setWorkingMessage(msg);
}

export function handleTurnEnd(ctx: ExtensionContext, runtime: PandiRuntime): void {
	if (!runtime.enabled) return;
	ctx.ui.setWorkingMessage();
}
