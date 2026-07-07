/** Static artifact viewer generated next to workflow run report.html. */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RunReportModel } from "./run-report-html.js";
import { artifactViewerAnchor, escapeHtml, safeRelativeHref } from "./run-report-safe-html.js";

export const ARTIFACT_VIEWER_FILE = "artifact-viewer.html";
const ARTIFACT_PREVIEW_BYTES = 160_000;

async function readPreview(
	file: string,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean; empty: boolean }> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) return { text: "", truncated: false, empty: true };
		const handle = await fs.open(file, "r");
		try {
			const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return {
				text: buffer.subarray(0, bytesRead).toString("utf8"),
				truncated: stat.size > bytesRead,
				empty: stat.size === 0,
			};
		} finally {
			await handle.close();
		}
	} catch {
		return { text: "", truncated: false, empty: true };
	}
}

function containedFile(runDir: string, rel: string): string | undefined {
	if (!safeRelativeHref(rel)) return undefined;
	const root = path.resolve(runDir);
	const file = path.resolve(root, rel);
	if (file !== root && file.startsWith(root + path.sep)) return file;
	return undefined;
}

export async function buildRunArtifactViewerHtml(model: RunReportModel, runDir: string): Promise<string> {
	const rows: string[] = [];
	const sections: string[] = [];
	for (const artifact of model.artifacts) {
		const anchor = artifactViewerAnchor(artifact.path);
		const rawHref = safeRelativeHref(artifact.path);
		if (!anchor || !rawHref) continue;
		const file = containedFile(runDir, artifact.path);
		const preview = file ? await readPreview(file, ARTIFACT_PREVIEW_BYTES) : undefined;
		const size = artifact.bytes === undefined ? "" : `${artifact.bytes} bytes`;
		rows.push(
			`<tr><td><a href="#${anchor}">${escapeHtml(artifact.path)}</a></td><td class="mono">${escapeHtml(size)}</td></tr>`,
		);
		const body = preview?.empty
			? `<div class="empty">Empty file.</div>`
			: `<pre>${escapeHtml(preview?.text ?? "Unable to read file.")}</pre>`;
		sections.push(
			`<section id="${anchor}"><h2>${escapeHtml(artifact.path)}</h2>` +
				`<div class="meta">${escapeHtml(size || "size unknown")}` +
				(preview?.truncated ? ` · preview truncated at ${ARTIFACT_PREVIEW_BYTES} bytes` : "") +
				` · <a href="${rawHref}">raw file</a></div>${body}</section>`,
		);
	}

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${model.workflow} — artifact viewer`)}</title>
<style>
:root { color-scheme: light dark; --bg:#242526; --fg:#f3f3f2; --muted:#b7b9bd; --card:#2f3136; --line:#4a4d55; --accent:#8aadf4; }
@media (prefers-color-scheme: light) { :root { --bg:#f8f8f7; --fg:#1f2328; --muted:#59636e; --card:#ffffff; --line:#d0d7de; --accent:#0969da; } }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
a { color:var(--accent); }
.container { max-width:1180px; margin:0 auto; padding:32px 20px 56px; }
.card, section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; margin:18px 0; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
.mono, pre { font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
.meta, .empty { color:var(--muted); margin:0 0 12px; }
pre { overflow:auto; white-space:pre-wrap; word-break:break-word; background:rgba(127,127,127,.10); border:1px solid var(--line); border-radius:10px; padding:14px; max-height:70vh; }
</style>
</head>
<body>
<div class="container">
<h1>Artifact viewer</h1>
<p class="meta">Static previews for ${escapeHtml(model.runId)}. Large files are bounded so this page stays responsive; use “raw file” for the original.</p>
<div class="card"><table><thead><tr><th>File</th><th>Bytes</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
${sections.join("\n")}
</div>
</body>
</html>`;
}
