/**
 * Claude-style `/rename` command for Pi.
 *
 * Claude Code's `/rename [name]` renames the current conversation: with an argument it
 * uses that name, and with no argument it auto-generates one from the conversation
 * history. Pi already has a native `/name <name>` that sets the session display name,
 * but it has no no-argument auto-generate path. This extension adds `/rename` as a
 * functional SUPERSET of `/name` (it coexists with `/name`, never overrides it):
 *
 *   /rename Refactor auth   -> pi.setSessionName("Refactor auth")
 *   /rename "  some  name " -> normalized -> pi.setSessionName("some name")
 *   /rename                 -> derive a suggestion from history; in a TUI, prefill an
 *                              input dialog to confirm/edit; headless, apply it directly.
 *
 * The naming logic is deterministic and lives in ./derive-name (no LLM, no network),
 * so it is fully unit-testable. index.ts only orchestrates the Pi API and the UI.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SESSION_NAME, deriveSessionName, normalizeName } from "./derive-name.js";
import { notify } from "./notify.js";

function readEntries(ctx: ExtensionCommandContext): unknown[] {
	try {
		return ctx.sessionManager?.getEntries?.() ?? [];
	} catch {
		return [];
	}
}

function suggestName(ctx: ExtensionCommandContext): string {
	return deriveSessionName(readEntries(ctx), { defaultName: DEFAULT_SESSION_NAME });
}

/** Normalize and apply a name via pi.setSessionName, reporting success/failure. */
function applyName(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawName: string): boolean {
	const finalName = normalizeName(rawName) || DEFAULT_SESSION_NAME;
	try {
		pi.setSessionName(finalName);
		notify(ctx, `Session renamed to "${finalName}".`, "info");
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `Failed to rename session: ${message}`, "error");
		return false;
	}
}

export default function renameExtension(pi: ExtensionAPI): void {
	pi.registerCommand("rename", {
		description: "Rename the current session. With no argument, suggests a name from the conversation.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed) {
				applyName(pi, ctx, trimmed);
				return;
			}

			// No argument: auto-generate a deterministic suggestion from history.
			const suggestion = suggestName(ctx);

			if (ctx.hasUI) {
				const entered = await ctx.ui.input("Rename session", suggestion);
				if (entered === undefined) {
					notify(ctx, "Rename cancelled.", "info");
					return;
				}
				// Empty submit accepts the suggestion; otherwise use what the user typed.
				applyName(pi, ctx, entered.trim() || suggestion);
				return;
			}

			// Headless: apply the suggestion directly.
			applyName(pi, ctx, suggestion);
		},
	});
}
