// util.mjs — tiny shared helpers for the workflow-artifact modules.

// De-dup / grouping key: strip trailing numeric/escalation indices from a label ("skeptic-3" -> "skeptic").
export const norm = (l) => String(l || "agent").replace(/(-e?\d+)+$/i, "").replace(/-\d+$/g, "");
// meta.phases entries may be plain strings ("asignacion") OR objects ({ title: "discover" }).
export const phaseTitleOf = (p) => (typeof p === "string" ? p : p && p.title);
