import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Standalone `/workflow` verbs (run without an extra argument) offered by the bare
 * `/workflow` selector. "list" is included so the previous bare default stays reachable;
 * verbs that need a `<name>`/`<run>` are left out of the menu (still typeable directly).
 */
const WORKFLOW_MENU_ITEMS = [
	"list — list saved workflows",
	"index — write the draft usage index (drafts/INDEX.md)",
	"patterns — browse the pattern scaffold catalog",
	"dashboard — open the interactive dashboard",
	"agents — open the dashboard on the agents view",
	"sessions — list background Pi sessions",
	"runs — list past workflow runs",
	"cleanup — remove stale runs",
];

/**
 * Resolve the `/workflow` argument, opening an interactive verb selector when the command
 * is invoked bare in a session with a UI (the "no args → menu" rule). Headless (no UI) and
 * explicit verbs keep the unchanged behavior; cancelling returns "", which handleWorkflowCommand
 * renders as its `list` default — so nothing regresses off-TUI.
 */
export async function resolveWorkflowMenu(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Dynamic workflows", WORKFLOW_MENU_ITEMS);
	return choice?.split(/\s+/)[0] ?? "";
}
