/**
 * Comando `/rename` estilo Claude para Pi.
 *
 * - derive-name.ts — slugify y resumen determinístico
 * - border-label.ts — composición de etiqueta en el borde
 * - name-border-editor.ts — capa TUI del editor
 * - command-handler.ts — `/rename` + hooks de sesión
 * - session-hooks.ts — borde al inicio + pista de salida
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRenameCommand } from "./command-handler.js";

export default function renameExtension(pi: ExtensionAPI): void {
	registerRenameCommand(pi);
}
