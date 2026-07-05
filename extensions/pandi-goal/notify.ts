/**
 * User-notification helper, local to this extension so it stays self-contained.
 *
 * INTENTIONAL DUPLICATION: a byte-identical copy lives in every extension that
 * needs it (pandi-plan, pandi-loop, pandi-goal, pandi-dynamic-workflows) instead of a
 * cross-extension `../shared/` import. Pi loads each extension self-contained (a
 * single file or a directory with its OWN helpers, via jiti filesystem
 * resolution), so a `../shared/` import only resolves while the whole package is
 * co-installed and breaks under per-extension distribution. Keep copies in sync
 * by hand; the function is tiny and stable.
 *
 * Decoupled from the SDK by a minimal STRUCTURAL context (`NotifyContext`) so it
 * does not import `ExtensionContext`; any real `ExtensionContext` satisfies it.
 *
 * NOTE: this self-contained family now shares the hardened stderr-routing
 * contract too. pi-docs carries the same behavior with a direct SDK context
 * import, and pi-mdview still keeps a command-only context type.
 */

export type NotifyType = "info" | "warning" | "error";

export interface NotifyContext {
	mode: string;
	hasUI: boolean;
	ui?: { notify(message: string, type?: NotifyType): void };
}

/**
 * Surface a message to the user.
 *
 * - print mode: write info to stdout, warnings/errors to stderr, and return.
 * - interactive with UI: delegate to `ctx.ui.notify`.
 * - headless without UI: keep info silent but surface warnings/errors on stderr.
 *
 * The `ctx.ui` truthiness guard preserves a no-op for structural test doubles
 * that omit `ui`, even though the real invariant is `hasUI` implies `ui`.
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
