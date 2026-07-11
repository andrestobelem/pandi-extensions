/**
 * Comando `/clear` al estilo Claude para Pi.
 *
 * En Claude Code, `/clear` limpia la conversación y empieza de cero. Pi ya trae un
 * `/new` nativo que inicia una sesión nueva, pero no `/clear`. Esta extensión agrega
 * `/clear` como alias para que la memoria muscular de Claude funcione en Pi
 * (convive con `/new`; nunca lo sobrescribe).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerClearCommand } from "./command-handler.js";

export default function clearExtension(pi: ExtensionAPI): void {
	registerClearCommand(pi);
}
