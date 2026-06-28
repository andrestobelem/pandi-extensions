// Setting parsers for pi-auto-compact-context. Env vars and `/auto-compact-context`
// subcommand arguments share this on/off + threshold grammar. Pure, no extension state;
// re-exported from index.ts so the built bundle keeps exporting the public parser names.

export const parseThreshold = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const parsed = Number(value.trim().replace(/%$/, ""));
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) return undefined;
	return parsed;
};

// Parse an on/off-style setting (env var or subcommand argument). Returns
// undefined for unrecognised input so callers can fall back to a default.
const parseOnOff = (value: string | undefined): boolean | undefined => {
	if (value === undefined) return undefined;
	const v = value.trim().toLowerCase();
	if (v === "on" || v === "1" || v === "true" || v === "yes" || v === "show") return true;
	if (v === "off" || v === "0" || v === "false" || v === "no" || v === "hide") return false;
	return undefined;
};
export const parseBarSetting = parseOnOff;
// Snapshots share the on/off grammar; aliased so callers/tests read intent clearly.
export const parseSnapshotSetting = parseOnOff;

// Parse the snapshot retention budget (a positive integer); undefined when invalid
// so the caller falls back to DEFAULT_SNAPSHOT_KEEP.
export const parseSnapshotKeep = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const n = Number(value.trim());
	if (!Number.isInteger(n) || n < 1) return undefined;
	return n;
};

// Tool-result clearing shares the on/off grammar (aliased for intent at call sites).
export const parseClearSetting = parseOnOff;

// Resolve a `/auto-compact-context <toggle> [on|off]` argument: an empty arg flips the
// current value, otherwise parse the explicit on/off token (undefined => unrecognised, so
// the caller shows usage). Shared by the bar/snapshot/clear-tools subcommands.
export const resolveToggle = (
	arg: string,
	current: boolean,
	parse: (value: string | undefined) => boolean | undefined,
): boolean | undefined => (arg === "" ? !current : parse(arg));
