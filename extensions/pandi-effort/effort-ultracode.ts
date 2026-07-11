import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setThinkingEffort } from "./effort-thinking.js";
import { notify } from "./notify.js";

// Mantené este string sincronizado con extensions/dynamic-workflows/index.ts.
export const ULTRACODE_MODE_EVENT = "pandi-dynamic-workflows:ultracode-mode";

function ensureToolActive(pi: ExtensionAPI, toolName: string): boolean {
	try {
		const active = pi.getActiveTools();
		if (active.includes(toolName)) return true;
		const exists = pi.getAllTools().some((tool) => tool.name === toolName);
		if (!exists) return false;
		pi.setActiveTools([...new Set([...active, toolName])]);
		return true;
	} catch {
		return false;
	}
}

export function enableUltracodeEffort(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const actual = setThinkingEffort(pi, ctx, "xhigh", { announce: false });
	const workflowToolActive = ensureToolActive(pi, "dynamic_workflow");
	pi.events.emit(ULTRACODE_MODE_EVENT, { enabled: true, source: "/effort" });
	const routerStatus = workflowToolActive
		? "router de dynamic_workflow habilitado"
		: "se pidió el router de dynamic_workflow, pero dynamic_workflow no está disponible en esta sesión";
	notify(ctx, `Esfuerzo ultracode habilitado (${actual}); ${routerStatus}.`, workflowToolActive ? "info" : "warning");
}
