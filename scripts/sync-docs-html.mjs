#!/usr/bin/env node
// sync-docs-html.mjs — mirror the human docs (root README.md + docs/**/*.md, minus the
// transient docs/conversaciones/) into `docs/html/` as COMMITTED, navigable HTML styled by
// the pi-docs converter (pandi artifact style). Same generator + --check shape as the other
// sync-*.mjs scripts: the mirror is a GENERATED artifact — do not hand-edit it; edit the
// Markdown source and re-run this. `npm test` runs the --check, so drift fails the gate.
//
// Mapping: README.md -> docs/html/index.html; docs/<path>.md -> docs/html/<path>.html.
// Relative .md links between in-set documents are rewritten to their .html mirror so the
// output browses like a site; external URLs and out-of-set targets are left untouched.
//
// Usage:
//   node scripts/sync-docs-html.mjs           # write/refresh the mirror (and prune orphans)
//   node scripts/sync-docs-html.mjs --check   # verify only; exit 1 on drift (no writes)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONVERTER = path.join(REPO, "extensions", "pi-docs", "scripts", "markdown-to-html.mjs");
const { renderMarkdownToHtml } = await import(pathToFileURL(CONVERTER).href);

const MIRROR = ["docs", "html"];

// Repo-relative .md path -> mirror-relative .html path, or null when out of set.
export function outPathFor(relMd) {
	const p = relMd.replaceAll("\\", "/");
	if (p === "README.md") return "index.html";
	if (!p.startsWith("docs/") || !p.endsWith(".md")) return null;
	if (p.startsWith("docs/conversaciones/") || p.startsWith("docs/html/")) return null;
	return `${p.slice("docs/".length, -".md".length)}.html`;
}

// Rewrite relative in-set .md hrefs in rendered HTML to their mirror .html equivalents.
export function rewriteHrefs(html, fromMd, set) {
	const fromOut = outPathFor(fromMd);
	if (!fromOut) return html;
	return html.replace(/href="([^"]+)"/g, (all, href) => {
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return all;
		const [target, anchor] = href.split("#");
		if (!target.endsWith(".md")) return all;
		const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromMd), target));
		const toOut = set.has(resolved) ? outPathFor(resolved) : null;
		if (!toOut) return all;
		const rel = path.posix.relative(path.posix.dirname(fromOut), toOut);
		return `href="${rel}${anchor ? `#${anchor}` : ""}"`;
	});
}

// Source-side rule: in-set Markdown links to Markdown; the mirror (not the author) owns the
// .md -> .html rewrite. A relative .html href whose target has an in-set .md twin (directly,
// or through the docs/html mirror) is a source error this script cannot fix — report it.
export function findBadSourceHrefs(html, fromMd, set) {
	const bad = [];
	for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) continue;
		const [target] = href.split("#");
		if (!target.endsWith(".html")) continue;
		const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromMd), target));
		const twin =
			resolved === "docs/html/index.html"
				? "README.md"
				: resolved.startsWith("docs/html/")
					? `docs/${resolved.slice("docs/html/".length, -".html".length)}.md`
					: `${resolved.slice(0, -".html".length)}.md`;
		if (set.has(twin)) bad.push({ file: fromMd, href, twin });
	}
	return bad;
}

// Discover the source set: root README.md + docs/**/*.md minus excluded subtrees.
function discoverSet(root) {
	const set = new Set();
	if (fs.existsSync(path.join(root, "README.md"))) set.add("README.md");
	const walk = (relDir) => {
		for (const entry of fs.readdirSync(path.join(root, relDir), { withFileTypes: true })) {
			const rel = path.posix.join(relDir, entry.name);
			if (entry.isDirectory()) walk(rel);
			else if (rel.endsWith(".md") && outPathFor(rel)) set.add(rel);
		}
	};
	if (fs.existsSync(path.join(root, "docs"))) walk("docs");
	return set;
}

// List every .html under the mirror as mirror-relative paths.
function listMirror(mirrorAbs) {
	const out = [];
	const walk = (rel) => {
		const abs = path.join(mirrorAbs, rel);
		if (!fs.existsSync(abs)) return;
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			const entryRel = rel ? path.posix.join(rel, entry.name) : entry.name;
			if (entry.isDirectory()) walk(entryRel);
			else if (entry.name.endsWith(".html")) out.push(entryRel);
		}
	};
	walk("");
	return out;
}

// Sync the mirror under `root`. check:true reports drift without touching disk.
// Returns { written, deleted, stale } (mirror-relative paths).
export function syncDocsHtml(root, opts = {}) {
	const check = !!opts.check;
	const set = discoverSet(root);
	const mirrorAbs = path.join(root, ...MIRROR);
	const written = [];
	const deleted = [];
	const stale = [];
	const badHrefs = [];

	const expected = new Map();
	for (const rel of set) {
		const md = fs.readFileSync(path.join(root, rel), "utf8");
		const kicker = rel === "README.md" ? path.basename(root) : path.posix.dirname(rel);
		const rendered = renderMarkdownToHtml(md, { title: path.posix.basename(rel), kicker });
		// Scan BEFORE rewriteHrefs: after it, every correct in-set .md link also reads .html.
		badHrefs.push(...findBadSourceHrefs(rendered, rel, set));
		expected.set(outPathFor(rel), rewriteHrefs(rendered, rel, set));
	}

	for (const [outRel, content] of expected) {
		const abs = path.join(mirrorAbs, outRel);
		const have = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
		if (have === content) continue;
		if (check) stale.push(outRel);
		else {
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, content);
			written.push(outRel);
		}
	}

	for (const outRel of listMirror(mirrorAbs)) {
		if (expected.has(outRel)) continue;
		if (check) stale.push(outRel);
		else {
			fs.rmSync(path.join(mirrorAbs, outRel));
			deleted.push(outRel);
		}
	}

	return { written, deleted, stale, badHrefs };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const check = process.argv.includes("--check");
	const { written, deleted, stale, badHrefs } = syncDocsHtml(REPO, { check });
	if (badHrefs.length) {
		console.error(`[sync-docs-html] ✗ ${badHrefs.length} .html link(s) in Markdown sources with an in-set .md twin:`);
		for (const b of badHrefs)
			console.error(`[sync-docs-html]   ${b.file}: ${b.href} -> link the source instead (${b.twin})`);
		console.error("[sync-docs-html]   Markdown links Markdown; the html mirror rewrites in-set .md links itself");
		process.exit(1);
	}
	if (check) {
		if (stale.length) {
			console.error(`[sync-docs-html] ✗ mirror drift (${stale.length}): ${stale.join(", ")}`);
			console.error("[sync-docs-html]   run `npm run sync:docs:html` and commit the result");
			process.exit(1);
		}
		console.log("[sync-docs-html] ✓ docs/html mirror is in sync");
	} else {
		for (const f of written) console.log(`[sync-docs-html] wrote ${f}`);
		for (const f of deleted) console.log(`[sync-docs-html] pruned ${f}`);
		if (!written.length && !deleted.length) console.log("[sync-docs-html] mirror already in sync");
	}
}
