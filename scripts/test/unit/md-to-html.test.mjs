// Unit tests for the pandi-artifact-style md-to-html converter.
// TDD pinning suite: pure core (renderMarkdownToHtml) + one CLI smoke test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, ".pi", "skills", "pandi-artifact-style", "scripts", "md-to-html.mjs");

const { renderMarkdownToHtml } = await import(pathToFileURL(SCRIPT).href);

test("renders a full self-contained page: h1 becomes the title, body keeps the prose, tokens embedded", () => {
	const html = renderMarkdownToHtml("# My report\n\nHello *world*.\n", {});
	assert.match(html, /<!doctype html>/i);
	assert.match(html, /<title>My report<\/title>/);
	assert.match(html, /<h1>My report<\/h1>/);
	assert.match(html, /Hello <em>world<\/em>\./);
	// Pandi tokens come from reference/pandi-tokens.css (dark base + light variant).
	assert.match(html, /--bg:\s*#242526/);
	assert.match(html, /prefers-color-scheme:\s*light/);
	// The h1 is promoted to the header, not duplicated in the body.
	assert.equal(html.match(/<h1>My report<\/h1>/g).length, 1);
});

test("kicker is configurable and defaults to Pandi artifact", () => {
	assert.match(renderMarkdownToHtml("# T\n\nx\n", {}), />Pandi artifact</);
	assert.match(renderMarkdownToHtml("# T\n\nx\n", { kicker: "Informe · demo" }), />Informe · demo</);
});

test("falls back to opts.title when the document has no h1", () => {
	const html = renderMarkdownToHtml("Just a paragraph.\n", { title: "fallback.md" });
	assert.match(html, /<title>fallback\.md<\/title>/);
	assert.match(html, /Just a paragraph\./);
});

test("renders GFM tables", () => {
	const html = renderMarkdownToHtml("# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", {});
	assert.match(html, /<table>/);
	assert.match(html, /<th>a<\/th>/);
	assert.match(html, /<td>2<\/td>/);
});

test("maps GitHub alerts to pandi callouts and strips the marker", () => {
	const html = renderMarkdownToHtml("# T\n\n> [!WARNING]\n> Coverage was capped.\n", {});
	assert.match(html, /class="callout warn"/);
	assert.match(html, /Coverage was capped\./);
	assert.doesNotMatch(html, /\[!WARNING\]/);
	// Each alert kind maps to its own class; plain blockquotes stay blockquotes.
	assert.match(renderMarkdownToHtml("# T\n\n> [!NOTE]\n> n\n", {}), /class="callout info"/);
	assert.match(renderMarkdownToHtml("# T\n\n> [!TIP]\n> t\n", {}), /class="callout success"/);
	assert.match(renderMarkdownToHtml("# T\n\n> [!CAUTION]\n> c\n", {}), /class="callout error"/);
	assert.match(renderMarkdownToHtml("# T\n\n> plain quote\n", {}), /<blockquote>/);
});

test("escapes HTML inside code fences", () => {
	const html = renderMarkdownToHtml('# T\n\n```html\n<script>alert("x")</script>\n```\n', {});
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script>alert/);
});

test("CLI converts a .md file to a sibling .html", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pandi-md2html-"));
	try {
		const mdPath = path.join(dir, "informe.md");
		fs.writeFileSync(mdPath, "# CLI smoke\n\nBody here.\n");
		execFileSync(process.execPath, [SCRIPT, mdPath], { encoding: "utf8" });
		const html = fs.readFileSync(path.join(dir, "informe.html"), "utf8");
		assert.match(html, /<title>CLI smoke<\/title>/);
		assert.match(html, /Body here\./);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
