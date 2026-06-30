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
 *   /rename                 -> invent a slug from the MOST RECENT activity and apply it
 *                              directly (no dialog); re-running it tracks current work.
 *
 * Every applied name is a slug. The current name is shown as an inverted-color pill
 * embedded in the editor's top border (the violet prompt line), right where
 * dynamic-workflows shows "ultracode auto" — composing as "ultracode auto ── <slug>"
 * (existing label first, name last, joined by the border line) when both are present.
 * pi-rename wraps
 * the editor with its own outer layer (delegating everything but render), so it neither
 * imports nor depends on dynamic-workflows. Naming logic is deterministic and lives in
 * ./derive-name; the border math lives in ./border-label.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { composeTopBorder } from "./border-label.js";
import { DEFAULT_SESSION_NAME, deriveSessionName, slugify } from "./derive-name.js";
import { notify } from "./notify.js";

const NAME_EDITOR_MARKER = "__piRenameNameBorderEditor";
const SET_PROVIDER = "__piRenameSetBorderProvider";

/** The most recently created wrapped editor, nudged to repaint after a rename. */
let latestEditor: { invalidate?: () => void } | undefined;

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

/** The border label for the current session name, or undefined when unnamed. */
function borderLabel(pi: ExtensionAPI): string | undefined {
	return safeName(pi) || undefined;
}

/** Slugify and apply a name via pi.setSessionName, reporting success/failure. */
function applyName(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawName: string): boolean {
	const finalName = slugify(rawName) || DEFAULT_SESSION_NAME;
	try {
		pi.setSessionName(finalName);
		notify(ctx, `Session renamed to "${finalName}".`, "info");
		// Nudge the editor so the border label updates immediately.
		latestEditor?.invalidate?.();
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `Failed to rename session: ${message}`, "error");
		return false;
	}
}

/**
 * Wrap an editor with a transparent outer layer that only overrides render(), adding the
 * session-name label to the top border. Everything else delegates to the base editor, so
 * the underlying behavior (typing, submit, dynamic-workflows' Down-key dashboard) is
 * preserved. A marker + provider setter let install reuse this layer across reloads.
 */
function wrapEditorWithNameBorder(
	base: EditorComponent,
	holder: { provider: () => string | undefined },
): EditorComponent {
	return new Proxy(base as object, {
		get(target, prop) {
			if (prop === NAME_EDITOR_MARKER) return true;
			if (prop === SET_PROVIDER) {
				return (next: () => string | undefined) => {
					holder.provider = next;
				};
			}
			if (prop === "render") {
				return (width: number): string[] => {
					const lines = (target as EditorComponent).render(width);
					const label = holder.provider();
					if (!label || lines.length === 0) return lines;
					const color = (target as { borderColor?: (value: string) => string }).borderColor ?? ((s) => s);
					// The name renders as a "pill": inverted fg/bg (reverse video) over the border color.
					const labelColor = (value: string) => `\x1b[7m${color(value)}\x1b[27m`;
					const decorated = composeTopBorder(lines[0], width, label, { color, labelColor });
					if (decorated == null) return lines;
					const out = [...lines];
					out[0] = decorated;
					return out;
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	}) as unknown as EditorComponent;
}

/** Install (or reuse) the outer editor layer that shows the name in the top border. */
function installNameBorderLabel(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || typeof ctx.ui.setEditorComponent !== "function") return;
	const holder = { provider: () => borderLabel(pi) };
	const previous = ctx.ui.getEditorComponent?.();
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		const existing = base as {
			[NAME_EDITOR_MARKER]?: boolean;
			[SET_PROVIDER]?: (next: () => string | undefined) => void;
		};
		// Reuse our own layer across reloads instead of stacking another proxy.
		if (existing[NAME_EDITOR_MARKER]) {
			existing[SET_PROVIDER]?.(holder.provider);
			latestEditor = base as { invalidate?: () => void };
			return base as EditorComponent;
		}
		const wrapped = wrapEditorWithNameBorder(base as EditorComponent, holder);
		latestEditor = wrapped as unknown as { invalidate?: () => void };
		return wrapped;
	});
}

export default function renameExtension(pi: ExtensionAPI): void {
	pi.registerCommand("rename", {
		description:
			"Rename the current session to a slug. With no argument, suggests one from your most recent activity.",
		handler: async (args, ctx) => {
			// With a name, use it; with no name, invent one from the most recent user message
			// (so a repeated /rename tracks current work). Never opens an input dialog.
			const trimmed = args.trim();
			applyName(pi, ctx, trimmed || suggestName(ctx));
		},
	});

	// Show the current name in the editor's top border (TUI only).
	pi.on("session_start", async (_event, ctx) => {
		installNameBorderLabel(pi, ctx);
	});
}
