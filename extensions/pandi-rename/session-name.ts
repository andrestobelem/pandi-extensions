import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SESSION_NAME, slugify } from "./derive-name.js";
import { invalidateNameBorder } from "./name-border-editor.js";
import { notify } from "./notify.js";

export function readEntries(ctx: ExtensionCommandContext): unknown[] {
	try {
		return ctx.sessionManager?.getEntries?.() ?? [];
	} catch {
		return [];
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatRenameFailure(error: unknown): string {
	return `No se pudo renombrar la sesión: ${errorMessage(error)}`;
}

/** Convierte un nombre en slug y lo aplica vía pi.setSessionName, reportando éxito/falla. */
export function applyName(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rawName: string,
	onApplied?: (name: string) => void,
): boolean {
	const finalName = slugify(rawName) || DEFAULT_SESSION_NAME;
	try {
		pi.setSessionName(finalName);
		onApplied?.(finalName);
		notify(ctx, `Sesión renombrada a "${finalName}".`, "info");
		invalidateNameBorder();
		return true;
	} catch (error) {
		notify(ctx, formatRenameFailure(error), "error");
		return false;
	}
}
