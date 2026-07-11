/**
 * Helper de notificación al usuario, local a esta extensión para que siga
 * siendo autocontenida.
 *
 * DUPLICACIÓN INTENCIONAL: vive una copia byte-idéntica en cada extensión que
 * la necesita (pandi-plan, pandi-loop, pandi-goal, pandi-dynamic-workflows), en
 * vez de un import cross-extension `../shared/`. Pi carga cada extensión de
 * forma autocontenida (un solo archivo o un directorio con sus PROPIOS helpers,
 * vía resolución de filesystem de jiti), así que un import `../shared/` solo
 * resuelve mientras todo el paquete está co-instalado y se rompe bajo
 * distribución por extensión. Mantené las copias sincronizadas a mano; la
 * función es chica y estable.
 *
 * Desacoplado del SDK mediante un contexto STRUCTURAL mínimo (`NotifyContext`),
 * así que no importa `ExtensionContext`; cualquier `ExtensionContext` real lo
 * satisface.
 *
 * NOTE: esta familia autocontenida ahora también comparte el contrato
 * endurecido de ruteo a stderr. pandi-docs lleva el mismo comportamiento con un
 * import directo del contexto del SDK, y pandi-mdview todavía conserva un tipo de
 * contexto solo de comando.
 */

export type NotifyType = "info" | "warning" | "error";

export interface NotifyContext {
	mode: string;
	hasUI: boolean;
	ui?: { notify(message: string, type?: NotifyType): void };
}

/**
 * Muestra un mensaje al usuario.
 *
 * - modo print: escribe info en stdout, warnings/errors en stderr, y retorna.
 * - interactivo con UI: delega en `ctx.ui.notify`.
 * - headless sin UI: mantiene info en silencio, pero muestra warnings/errors en stderr.
 *
 * El guard de truthiness de `ctx.ui` preserva un no-op para test doubles
 * estructurales que omiten `ui`, aunque la invariante real es que `hasUI`
 * implica `ui`.
 */
export function notify(ctx: NotifyContext, message: string, type: NotifyType = "info"): void {
	if (ctx.mode === "print") {
		(type === "info" ? console.log : console.error)(message);
		return;
	}
	if (ctx.hasUI && ctx.ui) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type !== "info") console.error(message);
}
