/** Guards compartidos de escaping/links para superficies HTML de run-report. */

/** Un escaper para contextos de texto Y atributos: & < > " ' (nunca la variante de 3 chars). */
export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Sanitiza un candidato href: solo paths RELATIVOS. Rechaza esquemas URL ("js:",
 * "http:"…), paths absolutos, backslashes y cualquier segmento ".."; URL-encodea cada
 * segmento para el contexto de atributo. Devuelve undefined cuando se rechaza.
 */
export function safeRelativeHref(candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;
	if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return undefined; // any scheme
	if (candidate.startsWith("/") || candidate.startsWith("\\") || candidate.includes("\\")) return undefined;
	const segments = candidate.split("/");
	if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
	return segments.map((s) => encodeURIComponent(s)).join("/");
}

function stableId(value: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
	return h.toString(16).padStart(8, "0");
}

export function artifactViewerAnchor(candidate: string | undefined): string | undefined {
	const safe = safeRelativeHref(candidate);
	if (!safe || !candidate) return undefined;
	return `artifact-${stableId(candidate)}-${safe.replaceAll("/", "-")}`;
}

export function artifactViewerHref(candidate: string | undefined): string | undefined {
	const anchor = artifactViewerAnchor(candidate);
	return anchor ? `artifact-viewer.html#${anchor}` : undefined;
}
