/**
 * Claude-style `/rename` command for Pi.
 *
 * Claude Code's `/rename [name]` renames the current conversation: with an argument it
 * uses that name, and with no argument it auto-generates one from the conversation
 * history. Pi already has a native `/name <name>` that sets the session display name,
 * but it has no no-argument auto-generate path. This extension adds `/rename` as a
 * functional SUPERSET of `/name` (it coexists with `/name`, never overrides it):
 *
 *   /rename Refactor auth   -> pi.setSessionName("refactor-auth")
 *   /rename "Hello World!"  -> pi.setSessionName("hello-world")
 *   /rename                 -> derive a slug from history; in a TUI, prefill an input
 *                              dialog to confirm/edit; headless, apply it directly.
 *
 * Every applied name is a slug. The current name is shown as a persistent label in the
 * footer/status bar (mirroring Claude Code's prompt-bar name). The naming logic is
 * deterministic and lives in ./derive-name (no LLM, no network), so it is fully
 * unit-testable; index.ts only orchestrates the Pi API and the UI.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SESSION_NAME, deriveSessionName, slugify } from "./derive-name.js";
import { notify } from "./notify.js";

const NAME_STATUS_KEY = "session-name";

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

function safeName(pi: ExtensionAPI): string | undefined {
	try {
		return pi.getSessionName();
	} catch {
		return undefined;
	}
}

function formatNameStatus(ctx: ExtensionContext, name: string): string {
	const text = `⌗ ${name}`;
	const theme = ctx.ui?.theme;
	return theme?.fg ? theme.fg("accent", text) : text;
}

/** Reflect the current session name in the footer/status bar (no-op without UI). */
function updateNameStatus(pi: ExtensionAPI, ctx: ExtensionContext, name = safeName(pi)): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(NAME_STATUS_KEY, name ? formatNameStatus(ctx, name) : undefined);
}

/** Slugify and apply a name via pi.setSessionName, reporting success/failure. */
function applyName(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawName: string): boolean {
	const finalName = slugify(rawName) || DEFAULT_SESSION_NAME;
	try {
		pi.setSessionName(finalName);
		notify(ctx, `Session renamed to "${finalName}".`, "info");
		updateNameStatus(pi, ctx, finalName);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `Failed to rename session: ${message}`, "error");
		return false;
	}
}

export default function renameExtension(pi: ExtensionAPI): void {
	pi.registerCommand("rename", {
		description: "Rename the current session to a slug. With no argument, suggests one from the conversation.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed) {
				applyName(pi, ctx, trimmed);
				return;
			}

			// No argument: auto-generate a deterministic slug from history.
			const suggestion = suggestName(ctx);

			if (ctx.hasUI) {
				const entered = await ctx.ui.input("Rename session (slug)", suggestion);
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

	// Keep the footer label in sync with the current name across the session lifecycle.
	pi.on("session_start", async (_event, ctx) => {
		updateNameStatus(pi, ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(NAME_STATUS_KEY, undefined);
	});
}
