/**
 * User-notification helper, local to this extension so it stays self-contained.
 *
 * INTENTIONAL DUPLICATION: a byte-identical copy lives in every extension that
 * needs it (pi-plan, pi-loop, pi-goal, pi-dynamic-workflows) instead of a
 * cross-extension `../shared/` import. Pi loads each extension self-contained (a
 * single file or a directory with its OWN helpers, via jiti filesystem
 * resolution), so a `../shared/` import only resolves while the whole package is
 * co-installed and breaks under per-extension distribution. Keep copies in sync
 * by hand; the function is tiny and stable.
 *
 * Decoupled from the SDK by a minimal STRUCTURAL context (`NotifyContext`) so it
 * does not import `ExtensionContext`; any real `ExtensionContext` satisfies it.
 *
 * NOTE: pi-effort and pi-mdview deliberately keep their OWN hardened variants
 * (they route warnings/errors to stderr in print/headless mode and pi-mdview
 * uses a command-only context type), so they are intentionally not in this set.
 */

export type NotifyType = "info" | "warning" | "error";

export type NotifyContext = {
	mode: string;
	hasUI: boolean;
	ui?: { notify(message: string, type?: NotifyType): void };
};

/**
 * Surface a message to the user.
 *
 * - print mode: write to stdout (machine-readable channel) and return.
 * - interactive with UI: delegate to `ctx.ui.notify`.
 *
 * The `ctx.ui` truthiness guard is a no-op under the real invariant (`hasUI`
 * implies `ui` is present).
 */
export function notify(ctx: NotifyContext, message: string, type: NotifyType = "info"): void {
	if (ctx.mode === "print") {
		console.log(message);
		return;
	}
	if (ctx.hasUI && ctx.ui) ctx.ui.notify(message, type);
}
