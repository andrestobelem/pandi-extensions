/**
 * Wake post-aprobación y guardias de modo para `/plan`.
 * Refleja el scheduler wake de pandi-loop: idle → steer, busy → followUp.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanFlags } from "./posture.js";

/**
 * ¿Puede esta sesión ejecutar el handshake de aprobación INTERACTIVO y el wake
 * reinyección? Solo TUI y RPC pueden.
 */
export function canApproveInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

/**
 * ¿Se puede ENTRAR al modo plan acá? Las sesiones interactivas siempre pueden. Una sesión
 * no-interactiva puede entrar solo con nonInteractive (solo plan).
 */
export function canEnterPlanMode(ctx: ExtensionContext, flags: PlanFlags): boolean {
	if (canApproveInMode(ctx)) return true;
	return (ctx.mode === "print" || ctx.mode === "json") && flags.nonInteractive === true;
}

/**
 * Reinyecta el prompt de implementación después de aprobación. Mode-gated así que nunca
 * dispara fuera de tui/rpc (defiende rutas rehydrate también).
 */
export function wake(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (!canApproveInMode(ctx)) return;
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}
