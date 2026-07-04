/**
 * Exit-time session-name hint.
 *
 * pi core prints `To resume this session: pi --session <uuid>` right before
 * `process.exit(0)` — always the UUID, never the display name (upstream FR:
 * https://github.com/earendil-works/pi/issues/6296). A process `exit` hook runs
 * synchronously AFTER that core write, so this module uses one to add a single dim
 * line directly beneath it when the session has a name:
 *
 *   Session name: docs-html-mirror-sync (resume by name: pi -r)
 *
 * The mutable state (current name) lives in a holder registered under a global
 * Symbol: `/reload` re-imports the extension in a fresh module scope, and reusing
 * the registered holder keeps ONE exit hook (and one printed line) across reloads
 * instead of stacking a duplicate per reload. If upstream ships #6296 this line
 * becomes redundant but stays harmless (it prints the same name).
 */

export const EXIT_HINT_KEY = Symbol.for("pi-rename.exit-name-hint");

/** Injected process surface so the behavior is testable without a real process. */
export interface ExitNameHintIO {
	isTTY(): boolean;
	onExit(hook: () => void): void;
	write(text: string): void;
}

interface Holder {
	name: string | undefined;
}

/** The dim one-liner printed under pi core's exit resume hint. */
export function formatExitNameHint(name: string): string {
	const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
	return `${dim("Session name:")} ${name} ${dim("(resume by name: pi -r)")}\n`;
}

/**
 * Install the exit hook (or reuse the one a previous load registered) and return a
 * setter for the current session name. Returns undefined off-TTY (piped stdout,
 * print mode), where the line would pollute machine-readable output.
 */
export function installExitNameHint(
	io: ExitNameHintIO,
	registry: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): ((name: string | undefined) => void) | undefined {
	if (!io.isTTY()) return undefined;
	const makeSetter = (holder: Holder) => (name: string | undefined) => {
		holder.name = name?.trim() || undefined;
	};
	const existing = registry[EXIT_HINT_KEY] as Holder | undefined;
	if (existing) return makeSetter(existing);
	const holder: Holder = { name: undefined };
	registry[EXIT_HINT_KEY] = holder;
	io.onExit(() => {
		if (holder.name) io.write(formatExitNameHint(holder.name));
	});
	return makeSetter(holder);
}
