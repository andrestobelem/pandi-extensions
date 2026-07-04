import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MAX_MDVIEW_BYTES = 2_000_000; // guard: reading/parsing a huge file blocks the TUI event loop

function stripWrappingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function resolveMarkdownPath(rawPath: string, cwd: string): string | undefined {
	const requested = stripWrappingQuotes(rawPath);
	if (!requested) return undefined;
	if (requested === "~") return os.homedir();
	if (requested.startsWith("~/")) return path.join(os.homedir(), requested.slice(2));
	return path.resolve(cwd, requested);
}

export type MarkdownLoad =
	| { ok: true; filePath: string; content: string; bytes: number }
	| { ok: false; message: string; level: "warning" | "error" };

/**
 * Resolve + size-guard + read a Markdown file. Shared by the `/mdview` command and the
 * model-callable `view_markdown` tool so both apply the SAME validation and limits.
 * Pure of UI: callers decide how to surface success (viewer / content) and errors.
 */
export async function loadMarkdownDocument(pathArg: string, cwd: string): Promise<MarkdownLoad> {
	const filePath = resolveMarkdownPath(pathArg, cwd);
	if (!filePath) return { ok: false, message: "Usage: /mdview <path-to-markdown-file>", level: "warning" };
	try {
		const stat = await fs.stat(filePath);
		if (stat.size > MAX_MDVIEW_BYTES) {
			return {
				ok: false,
				message: `Markdown file is too large to view (${stat.size} bytes; limit ${MAX_MDVIEW_BYTES} bytes) — open it in an external editor instead.`,
				level: "warning",
			};
		}
		const content = await fs.readFile(filePath, "utf8");
		return { ok: true, filePath, content, bytes: stat.size };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `Could not read Markdown file: ${message}`, level: "error" };
	}
}
