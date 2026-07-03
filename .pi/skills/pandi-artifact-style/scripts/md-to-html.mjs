#!/usr/bin/env node
// md-to-html.mjs — convert Markdown into a self-contained HTML artifact styled with the
// pandi-artifact-style manual (Claude-design layout × Panda Syntax palette).
//
// Tokens are read at runtime from ../reference/pandi-tokens.css (single source of truth,
// derived from extensions/pi-pandi-theme/themes/panda-syntax-{dark,light}.json).
//
// Usage:
//   node md-to-html.mjs <input.md> [more.md…] [-o output.html] [--kicker "Text"]
//
// Without -o each input writes a sibling <input>.html; -o is only valid with one input.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { marked } from "marked";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS_CSS_PATH = path.join(SKILL_DIR, "reference", "pandi-tokens.css");

const ALERT_CALLOUTS = {
	NOTE: "info",
	TIP: "success",
	IMPORTANT: "info",
	WARNING: "warn",
	CAUTION: "error",
};

// Component styles for the rendered Markdown body — the recipes from SKILL.md
// (paper/ink surfaces, quiet hierarchy, uppercase section headings, monospace for code).
const BODY_CSS = `
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
       font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif; }
.container { max-width:980px; margin:0 auto; padding:0 24px 80px; }
header { padding:40px 0 8px; }
header .kicker { font-size:12px; letter-spacing:.12em; text-transform:uppercase;
                 color:var(--accent); font-weight:600; }
header h1 { margin:6px 0; font-size:28px; }
main h2 { font-size:20px; color:var(--ink); margin:32px 0 10px; font-weight:600; }
main h3 { font-size:16px; color:var(--ink); margin:22px 0 8px; font-weight:600; }
main h4 { font-size:14px; color:var(--ink); margin:18px 0 6px; font-weight:600; }
main h5, main h6 { font-size:13px; color:var(--ink2); margin:16px 0 6px; font-weight:600; }
main p, main li { color:var(--ink2); text-align:justify; hyphens:auto; }
main li { margin:3px 0; }
a { color:var(--link); }
strong { color:var(--ink); }
code { font-family:ui-monospace,Menlo,monospace; font-size:12.5px; color:var(--code);
       background:var(--raised); padding:1px 6px; border-radius:5px; }
pre { background:var(--paper); border:1px solid var(--line); border-radius:12px;
      padding:16px; overflow:auto; font-size:12.5px; line-height:1.6; }
pre code { background:none; padding:0; color:var(--ink); }
blockquote { border-left:3px solid var(--accent); margin:8px 0; padding:2px 14px; color:var(--ink2); }
blockquote p { margin:6px 0; }
hr { border:none; border-top:1px solid var(--line-strong); margin:24px 0; }
table { border-collapse:collapse; margin:12px 0; background:var(--paper);
        border:1px solid var(--line); border-radius:12px; overflow:hidden; }
th, td { border-bottom:1px solid var(--line); padding:8px 12px; text-align:left; font-size:13.5px; }
th { font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted);
     background:var(--raised); }
tr:last-child td { border-bottom:none; }
.callout { margin:12px 0; padding:10px 14px; border-radius:10px; font-size:13.5px;
           border:1px solid var(--line); background:var(--paper); color:var(--ink); }
.callout p { margin:6px 0; color:var(--ink); max-width:none; }
.callout.info    { background:var(--info-bg);    border-color:var(--purple); }
.callout.success { background:var(--success-bg); border-color:var(--success); }
.callout.warn    { background:var(--warning-bg); border-color:var(--warning); }
.callout.error   { background:var(--error-bg);   border-color:var(--error); }
footer { margin-top:40px; color:var(--muted); font-size:12.5px; }
`;

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Extract the first top-level `# heading` as the page title and drop it from the body.
function splitTitle(md) {
	const lines = md.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*$/.test(line)) continue;
		const m = /^#\s+(.+?)\s*$/.exec(line);
		if (m) return { title: m[1], body: [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n") };
		break; // first non-blank line is not an h1 — keep the document intact
	}
	return { title: null, body: md };
}

// Map GitHub alert blockquotes (> [!NOTE] …) to pandi callouts by post-processing the
// rendered HTML: simpler and more stable than overriding marked's token renderers.
function alertsToCallouts(html) {
	const kinds = Object.keys(ALERT_CALLOUTS).join("|");
	const marker = new RegExp(`<blockquote>\\s*<p>\\[!(${kinds})\\]\\s*(?:<br\\s*/?>\\s*)?`, "g");
	let out = html.replace(marker, (_all, kind) => `<div class="callout ${ALERT_CALLOUTS[kind]}"><p>`);
	// Close the div only for blockquotes we opened as callouts.
	if (out !== html) out = out.replace(/<\/blockquote>/g, (close, idx) => {
		const opened = out.lastIndexOf("<div class=\"callout", idx);
		const openedQuote = out.lastIndexOf("<blockquote>", idx);
		return opened > openedQuote ? "</div>" : close;
	});
	return out;
}

export function renderMarkdownToHtml(md, opts = {}) {
	const tokensCss = opts.tokensCss ?? fs.readFileSync(TOKENS_CSS_PATH, "utf8");
	const kicker = opts.kicker ?? "Pandi artifact";
	const { title: docTitle, body } = splitTitle(md);
	const title = docTitle ?? opts.title ?? "Untitled";
	const rendered = alertsToCallouts(marked.parse(body, { gfm: true, async: false }));

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${tokensCss}
${BODY_CSS}</style>
</head>
<body>
<div class="container">
	<header>
		<div class="kicker">${escapeHtml(kicker)}</div>
		<h1>${escapeHtml(title)}</h1>
	</header>
	<main>
${rendered}	</main>
	<footer>Generated with the pandi-artifact-style skill · palette: panda-syntax dark/light</footer>
</div>
</body>
</html>
`;
}

function parseArgs(argv) {
	const inputs = [];
	let out = null;
	let kicker;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-o" || a === "--out") out = argv[++i];
		else if (a === "--kicker") kicker = argv[++i];
		else if (a === "-h" || a === "--help") return { help: true };
		else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
		else inputs.push(a);
	}
	return { inputs, out, kicker };
}

function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help || !parsed.inputs?.length) {
		console.log("Usage: md-to-html.mjs <input.md> [more.md…] [-o output.html] [--kicker \"Text\"]");
		process.exit(parsed.help ? 0 : 1);
	}
	if (parsed.out && parsed.inputs.length > 1) {
		console.error("-o is only valid with a single input");
		process.exit(1);
	}
	for (const input of parsed.inputs) {
		const md = fs.readFileSync(input, "utf8");
		const outPath = parsed.out ?? input.replace(/\.md$/i, "") + ".html";
		const html = renderMarkdownToHtml(md, { title: path.basename(input), kicker: parsed.kicker });
		fs.writeFileSync(outPath, html);
		console.log(`${input} -> ${outPath}`);
	}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
