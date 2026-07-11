/**
 * Comando `/exit` al estilo Claude para Pi.
 *
 * Claude Code usa `/exit` (y `/quit`) para salir de la sesión. Pi ya trae un `/quit`
 * nativo que cierra de forma limpia, pero no `/exit`. Esta extensión agrega `/exit` como
 * alias liviano para que la memoria muscular de Claude funcione en Pi (convive con `/quit`,
 * nunca lo reemplaza).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExitCommand } from "./command-handler.js";

export default function exitExtension(pi: ExtensionAPI): void {
	registerExitCommand(pi);
}
