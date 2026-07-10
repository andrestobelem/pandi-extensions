import type { RunReportText } from "./html.js";
import { renderRunReportMarkdown } from "./markdown.js";
import { escapeHtml } from "./safe-html.js";

export function chip(label: string, value: string | number | undefined): string {
	if (value === undefined || value === "") return "";
	return `<span class="chip">${escapeHtml(label)}: ${escapeHtml(String(value))}</span>`;
}

function truncNote(t: RunReportText): string {
	return t.truncated ? ` <span class="muted">…[truncated]</span>` : "";
}

type RenderMode = "pre" | "markdown" | "structured";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function parsedJsonOutput(text: string): { value: JsonValue; pretty: string } | undefined {
	const trimmed = text.trim();
	const first = trimmed[0];
	if (first !== "{" && first !== "[") return undefined;
	try {
		const value = JSON.parse(trimmed) as JsonValue;
		return { value, pretty: JSON.stringify(value, null, 2) };
	} catch {
		return undefined;
	}
}

export function prettyJsonOutput(text: string): string | undefined {
	return parsedJsonOutput(text)?.pretty;
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonScalar(value: JsonValue): value is null | boolean | number | string {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function humanizeKey(key: string): string {
	const words = key
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	return words.replace(/^./, (ch) => ch.toUpperCase());
}

function markdownScalar(value: JsonValue): string {
	if (value === null) return "`null`";
	if (typeof value === "string") return value.trim() || "_(empty)_";
	if (typeof value === "number" || typeof value === "boolean") return `\`${String(value)}\``;
	return `\`${JSON.stringify(value)}\``;
}

function markdownTableCell(value: JsonValue): string {
	return markdownScalar(value)
		.replace(/\|/g, "\\|")
		.replace(/\r?\n+/g, " / ");
}

function flatRecordKeys(rows: { [key: string]: JsonValue }[]): string[] {
	const keys: string[] = [];
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!keys.includes(key) && isJsonScalar(row[key])) keys.push(key);
		}
	}
	return keys;
}

function recordsToMarkdownTable(rows: { [key: string]: JsonValue }[]): string {
	const keys = flatRecordKeys(rows);
	if (keys.length === 0) return rows.map((row) => `- ${markdownScalar(row)}`).join("\n");
	const head = `| ${keys.map((key) => humanizeKey(key)).join(" | ")} |`;
	const sep = `| ${keys.map(() => "---").join(" | ")} |`;
	const body = rows.map((row) => `| ${keys.map((key) => markdownTableCell(row[key] ?? "")).join(" | ")} |`).join("\n");
	return `${head}\n${sep}\n${body}`;
}

function objectToKeyValueTable(record: { [key: string]: JsonValue }): string {
	const rows = Object.entries(record).filter(([, value]) => isJsonScalar(value));
	if (rows.length === 0) return "";
	return [
		"| Field | Value |",
		"| --- | --- |",
		...rows.map(([key, value]) => `| ${humanizeKey(key)} | ${markdownTableCell(value)} |`),
	].join("\n");
}

function structuredValueMarkdown(value: JsonValue, level = 3): string {
	if (Array.isArray(value)) {
		if (value.length === 0) return "_none_";
		if (value.every((item) => typeof item === "string")) return value.map((item) => `- ${item}`).join("\n");
		if (value.every(isJsonRecord)) return recordsToMarkdownTable(value as { [key: string]: JsonValue }[]);
		return value.map((item) => `- ${markdownScalar(item)}`).join("\n");
	}
	if (isJsonRecord(value)) {
		const scalarTable = objectToKeyValueTable(value);
		const nested = Object.entries(value)
			.filter(([, nestedValue]) => !isJsonScalar(nestedValue))
			.map(
				([key, nestedValue]) =>
					`${"#".repeat(Math.min(level, 6))} ${humanizeKey(key)}\n\n${structuredValueMarkdown(nestedValue, level + 1)}`,
			)
			.join("\n\n");
		return [scalarTable, nested].filter(Boolean).join("\n\n") || "_empty object_";
	}
	return markdownScalar(value);
}

function structuredJsonMarkdown(value: JsonValue): string {
	if (!isJsonRecord(value)) return structuredValueMarkdown(value);
	return Object.entries(value)
		.map(([key, child]) => `### ${humanizeKey(key)}\n\n${structuredValueMarkdown(child, 4)}`)
		.join("\n\n");
}

function renderStructuredJson(text: string): string | undefined {
	const parsed = parsedJsonOutput(text);
	if (!parsed) return undefined;
	return (
		`<div class="structured-output"><div class="md-body">${renderRunReportMarkdown(structuredJsonMarkdown(parsed.value))}</div></div>` +
		`<details class="raw-json"><summary>Raw JSON</summary><div class="body"><pre class="json-output">${escapeHtml(parsed.pretty)}</pre></div></details>`
	);
}

function renderTextBody(text: string, render: RenderMode): string {
	if (render === "structured") {
		const structured = renderStructuredJson(text);
		if (structured !== undefined) return structured;
		return `<div class="md-body">${renderRunReportMarkdown(text)}</div>`;
	}
	const json = prettyJsonOutput(text);
	if (json !== undefined) return `<pre class="json-output">${escapeHtml(json)}</pre>`;
	return render === "markdown"
		? `<div class="md-body">${renderRunReportMarkdown(text)}</div>`
		: `<pre>${escapeHtml(text)}</pre>`;
}

export function textBlock(
	title: string,
	t: RunReportText | undefined,
	open = false,
	render: RenderMode = "pre",
): string {
	if (!t) return "";
	const body = renderTextBody(t.text, render);
	return (
		`<details${open ? " open" : ""}><summary>${escapeHtml(title)}${truncNote(t)}</summary>` +
		`<div class="body">${body}</div></details>`
	);
}
