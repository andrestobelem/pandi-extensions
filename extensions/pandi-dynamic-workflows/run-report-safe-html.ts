/** Shared escaping/link guards for run-report HTML surfaces. */

/** One escaper for text AND attribute contexts: & < > " ' (never the 3-char variant). */
export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Sanitize an href candidate: RELATIVE paths only. Refuses URL schemes ("js:",
 * "http:"…), absolute paths, backslashes, and any ".." segment; URL-encodes each
 * segment for the attribute context. Returns undefined when refused.
 */
export function safeRelativeHref(candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;
	if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return undefined; // any scheme
	if (candidate.startsWith("/") || candidate.startsWith("\\") || candidate.includes("\\")) return undefined;
	const segments = candidate.split("/");
	if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
	return segments.map((s) => encodeURIComponent(s)).join("/");
}
