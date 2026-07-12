// util.mjs — helpers compartidos mínimos para los módulos de workflow-artifact.

// Clave para de-dup y agrupación: quita los índices numéricos o de escalación al final de un label ("skeptic-3" -> "skeptic").
export const norm = (l) => String(l || "agent").replace(/(-e?\d+)+$/i, "").replace(/-\d+$/g, "");
// Las entries de meta.phases pueden ser strings simples ("asignacion") U objetos ({ title: "discover" }).
export const phaseTitleOf = (p) => (typeof p === "string" ? p : p && p.title);

export function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function shortModel(value, inheritedFallback = "inherited") {
	if (!value || value === "inherited") return inheritedFallback;
	return String(value).split("/").pop();
}

export function plural(count, singular, pluralForm = `${singular}s`) {
	return count === 1 ? singular : pluralForm;
}

export function empty(value) {
	return value === undefined || value === null || value === "" || value === "—";
}

export function fallbackMeta(scriptPath) {
	return {
		name: scriptPath.split("/").pop().replace(/\.(?:m?js|cjs)$/, ""),
		description: "",
		phases: [],
	};
}

export function emptyPhase(value) {
	return value === undefined || value === null || value === "";
}

export function uniqueBy(items, isEmpty) {
	return [...new Set(items.filter((x) => !isEmpty(x)).map(String))];
}

export function monoHtml(value) {
	return `<code>${escapeHtml(value)}</code>`;
}
