// Pinning tests for the pi-docs markdown-to-html converter (moved here from the
// pandi-artifact-style skill). TDD pinning suite: pure core (renderMarkdownToHtml)
// + one CLI smoke test. node:test based; run-all executes the file directly and
// node:test sets a non-zero exit code on failure.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SCRIPT = path.join(REPO, "extensions", "pandi-docs", "scripts", "markdown-to-html.mjs");

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

test("strips YAML frontmatter before extracting the h1 title", () => {
	const html = renderMarkdownToHtml(
		'---\ntype: Research Note\ntitle: "Frontmatter title"\n---\n\n# Real title\n\nBody.\n',
		{ title: "fallback.md" },
	);
	assert.match(html, /<title>Real title<\/title>/);
	assert.match(html, /<h1>Real title<\/h1>/);
	assert.match(html, /Body\./);
	assert.doesNotMatch(html, /Research Note/);
	assert.doesNotMatch(html, /Frontmatter title/);
});

test("prose typography: body justified, h2 is a real heading above h3 (no uppercase label style)", () => {
	const html = renderMarkdownToHtml("# T\n\n## Section\n\ntext\n", {});
	assert.match(html, /text-align:\s*justify/);
	const h2Rule = /main h2 \{([^}]*)\}/.exec(html)?.[1] ?? "";
	const h3Rule = /main h3 \{([^}]*)\}/.exec(html)?.[1] ?? "";
	assert.doesNotMatch(h2Rule, /text-transform:\s*uppercase/);
	const px = (rule) => Number(/font-size:\s*([\d.]+)px/.exec(rule)?.[1] ?? 0);
	assert.ok(px(h2Rule) > px(h3Rule), `h2 (${px(h2Rule)}px) must be larger than h3 (${px(h3Rule)}px)`);
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

test("mermaid fences become pandi-themed diagrams; plain docs stay JS-free", () => {
	const withDiagram = renderMarkdownToHtml("# T\n\n```mermaid\nflowchart LR\n  A --> B\n```\n", {});
	assert.match(withDiagram, /<pre class="mermaid">/);
	assert.match(withDiagram, /flowchart LR/);
	assert.match(withDiagram, /mermaid(@|\.min)/); // CDN script present
	assert.match(withDiagram, /themeVariables/);
	assert.match(withDiagram, /#FF75B5/); // pandi accent wired into the mermaid theme
	// A document without mermaid must stay a no-JS artifact.
	const plain = renderMarkdownToHtml("# T\n\n```js\nconst a = 1;\n```\n", {});
	assert.doesNotMatch(plain, /<script/);
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
