/**
 * Shared user-notification helper for Pi extensions.
 *
 * Extracted verbatim from the byte-identical `notify()` copies that previously
 * lived in `pi-plan`, `pi-loop`, `pi-goal` and `pi-dynamic-workflows`
 * (DRY; behavior-preserving).
 *
 * Decoupled from the SDK by design: it accepts a minimal STRUCTURAL context
 * (`NotifyContext`) so it does not import `ExtensionContext`. Any real
 * `ExtensionContext` satisfies it. Lives at depth one under `extensions/` so it
 * matches the `package.json` `files` glob (one level deep) and is typechecked
 * transitively via the `.js` import from each extension's `index.ts`.
 *
 * NOTE: `pi-effort` and `pi-mdview` deliberately keep their own hardened
 * variants (they route warnings/errors to stderr in print/headless mode and
 * `pi-mdview` uses a command-only context type). Folding those in would change
 * their observable behavior, so it is intentionally NOT done here.
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
 * Behavior is identical to the four extracted copies; the `ctx.ui` truthiness
 * guard is a no-op under the real invariant (`hasUI` implies `ui` is present).
 */
export function notify(ctx: NotifyContext, message: string, type: NotifyType = "info"): void {
	if (ctx.mode === "print") {
		console.log(message);
		return;
	}
	if (ctx.hasUI && ctx.ui) ctx.ui.notify(message, type);
}
