/**
 * pandi-worktree: gestiona git worktrees desde dentro de una sesión de Pi.
 *
 * Arquitectura (modularizada al estilo pandi-plan):
 * - slash-handlers.ts — `/worktree` + `git_worktree`
 * - session-hooks.ts — session_start
 * - public-api.ts — reexports para bundles de integración
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorktreeSessionHooks } from "./session-hooks.js";
import { registerWorktreeCommand } from "./slash-handlers.js";
import { registerWorktreeWriterGuard } from "./writer-guard.js";

export * from "./public-api.js";

export default function worktreeExtension(pi: ExtensionAPI): void {
	registerWorktreeWriterGuard(pi);
	registerWorktreeSessionHooks(pi);
	registerWorktreeCommand(pi);
}
