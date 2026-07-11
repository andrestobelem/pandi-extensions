/**
 * pandi-worktree: gestiona git worktrees desde dentro de una sesión de Pi.
 *
 * Dos superficies (la convención del proyecto; ver pandi-mdview / pandi-local-memory):
 *   - `/worktree`        slash command humano (interactivo, confirmaciones, completions)
 *   - `git_worktree`     herramienta invocable por el modelo (acciones explícitas, sin borrados sorpresa)
 *
 * Ambas comparten los helpers puros de ./worktree.ts. `git` siempre se ejecuta
 * con un array ARGV (nunca una cadena de shell) para que paths/nombres de rama
 * no puedan inyectar comandos.
 *
 * Nota sobre cwd: el directorio de trabajo de Pi queda fijo al inicio y no
 * puede cambiar a mitad de la sesión, así que esta extensión nunca intenta
 * "mover" la sesión a otro worktree: expone el PATH absoluto de cada worktree
 * para que puedas abrir un Pi nuevo ahí (`cd <path> && pi`).
 *
 * Arquitectura (modularizada al estilo pandi-plan):
 * - slash command en slash-handlers.ts
 * - git_worktree tool en tool-handlers.ts
 * - open (Supacode tab + crear-si-falta) en open-worktree.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKTREE_ARGUMENT_COMPLETIONS } from "./constants.js";
import { resetSessionCopyDefaults } from "./copy-prefs.js";
import { runWorktreeCommand } from "./slash-handlers.js";
import { registerGitWorktreeTool } from "./tool-handlers.js";
import { registerWorktreeWriterGuard, resetWorktreeWriterGuardSessionDefault } from "./writer-guard.js";

// ParsedCommand + tokenize + parseCommand viven en ./command.ts; tokenize/parseCommand
// se reexportan para que el bundle construido conserve los nombres que importa la suite de integración.
export { parseCommand, tokenize } from "./command.js";
// Reexportado para que la suite de integración pueda probar unitariamente la resolución
// + el parsing de copy-defaults directamente contra el mismo bundle.
export {
	parseCopyToggleValue,
	resetSessionCopyDefaults,
	resolveCopyPrefs,
	setSessionCopyDefault,
} from "./copy-prefs.js";
// Reexportado para que la suite de integración pueda probar unitariamente los helpers puros
// directamente contra el mismo bundle. El uso interno sigue pasando por el import de arriba
// (un reexport `export … from` no crea un binding local, así que no hay choque).
export {
	buildAddArgs,
	buildListIgnoredArgs,
	buildListUntrackedArgs,
	describeWorktree,
	filterCopyableEntries,
	isValidBranchName,
	parseLsFilesEntries,
	parseWorktreeList,
} from "./worktree.js";
// Acciones compartidas slash/tool; reexport mínimo si la suite necesita characterization.
export { addWorktree, copyFilesToWorktree, copyNote } from "./worktree-actions.js";

export default function worktreeExtension(pi: ExtensionAPI): void {
	registerWorktreeWriterGuard(pi);

	// Los toggles de copia por defecto de la sesión viven en memoria; limpialos en cada límite de sesión
	// (refleja a pandi-plan reiniciando sus toggles de postura ultracode en session_start).
	pi.on("session_start", () => {
		resetSessionCopyDefaults();
		resetWorktreeWriterGuardSessionDefault();
	});

	pi.registerCommand("worktree", {
		description: "Gestionar worktrees de git: list | add | open | remove | prune",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/);
			// Completá solo el primer token (el subcomando).
			if (tokens.length > 1) return null;
			const needle = (tokens[0] ?? "").toLowerCase();
			const items = WORKTREE_ARGUMENT_COMPLETIONS.filter((item) => item.value.startsWith(needle));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			await runWorktreeCommand(ctx, args);
		},
	});

	registerGitWorktreeTool(pi);
}
