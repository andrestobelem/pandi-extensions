import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Interactive menu shown for a bare `/auto-compact` in a UI session. The text
// BEFORE " — " is the canonical command the handler already understands.
export const MENU_OPTIONS = [
	"status — show current settings",
	"on — enable auto-compaction",
	"off — disable auto-compaction",
	"run — compact context now",
	"bar on — show the footer progress bar",
	"bar off — hide the footer progress bar",
	"snapshot on — keep recoverable pre-compaction snapshots",
	"snapshot off — stop keeping snapshots",
	"snapshots — list recent snapshots",
	"clear-tools on — elide old large tool outputs (cheaper than compaction)",
	"clear-tools off — stop eliding old tool outputs",
	"threshold — set the compaction threshold %",
];

// Threshold presets offered after choosing "threshold"; the last entry opens a text input.
export const THRESHOLD_OPTIONS = ["20", "30", "40", "50", "60", "70", "80", "custom\u2026"];

// Argument autocomplete items. `value` is inserted into the editor on accept.
export const ARG_COMPLETIONS: { value: string; label: string; description: string }[] = [
	{ value: "status", label: "status", description: "Show current settings" },
	{ value: "on", label: "on", description: "Enable auto-compaction" },
	{ value: "off", label: "off", description: "Disable auto-compaction" },
	{ value: "run", label: "run", description: "Compact context now" },
	{ value: "bar", label: "bar", description: "Toggle the footer progress bar" },
	{ value: "bar on", label: "bar on", description: "Show the footer progress bar" },
	{ value: "bar off", label: "bar off", description: "Hide the footer progress bar" },
	{ value: "snapshot", label: "snapshot", description: "Toggle recoverable compaction snapshots" },
	{ value: "snapshot on", label: "snapshot on", description: "Keep recoverable pre-compaction snapshots" },
	{ value: "snapshot off", label: "snapshot off", description: "Stop keeping snapshots" },
	{ value: "snapshots", label: "snapshots", description: "List recent snapshots for this session" },
	{ value: "clear-tools", label: "clear-tools", description: "Toggle eliding old large tool outputs" },
	{ value: "clear-tools on", label: "clear-tools on", description: "Elide old large tool outputs per LLM call" },
	{ value: "clear-tools off", label: "clear-tools off", description: "Stop eliding old tool outputs" },
	{ value: "20", label: "20%", description: "Set threshold to 20%" },
	{ value: "30", label: "30%", description: "Set threshold to 30% (default)" },
	{ value: "40", label: "40%", description: "Set threshold to 40%" },
	{ value: "50", label: "50%", description: "Set threshold to 50%" },
	{ value: "60", label: "60%", description: "Set threshold to 60%" },
	{ value: "70", label: "70%", description: "Set threshold to 70%" },
	{ value: "80", label: "80%", description: "Set threshold to 80%" },
];

// When invoked bare in a UI session, open a menu to pick a setting (and a second
// menu/input for the threshold value); otherwise return the typed args unchanged.
// Returns a string the command handler already understands.
export async function resolveCommandValue(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI) return trimmed;

	const choice = await ctx.ui.select("Auto-compact context — choose a setting", MENU_OPTIONS);
	if (!choice) return "status"; // cancelled → harmless no-op (status)
	const command = choice.split(" — ")[0].trim();
	if (command !== "threshold") return command;

	const pick = await ctx.ui.select("Compaction threshold % (compact when usage reaches this)", THRESHOLD_OPTIONS);
	if (!pick) return "status";
	if (!pick.startsWith("custom")) return pick;
	const custom = await ctx.ui.input("Custom threshold percent (1\u201399)", "e.g. 35");
	return (custom ?? "").trim() || "status";
}
