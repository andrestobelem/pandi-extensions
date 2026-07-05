#!/usr/bin/env node
// sync-docs-html.mjs — espeja los docs humanos (README.md raíz + docs/**/*.md, salvo el
// transitorio docs/conversaciones/) en `docs/html/` como HTML COMMITTEADO y navegable, estilado por
// el converter de pandi-docs (pandi artifact style). Tiene la misma forma generator + --check que los otros
// scripts sync-*.mjs: el mirror es un artifact GENERATED — no lo edites a mano; editá la fuente
// Markdown y re-ejecutá esto. `npm test` corre el --check, así que el drift rompe la compuerta.
//
// Mapeo: README.md -> docs/html/index.html; docs/<path>.md -> docs/html/<path>.html.
// Los links relativos a .md entre documentos dentro del set se reescriben a su mirror .html para que
// la salida se navegue como un sitio; las URLs externas y los targets fuera del set quedan intactos.
//
// Uso:
//   node scripts/sync-docs-html.mjs           # escribe/refresca el mirror (y poda huérfanos)
//   node scripts/sync-docs-html.mjs --check   # solo verifica; sale con 1 si hay drift (sin writes)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONVERTER = path.join(REPO, "extensions", "pandi-docs", "scripts", "markdown-to-html.mjs");
const { renderMarkdownToHtml } = await import(pathToFileURL(CONVERTER).href);

const MIRROR = ["docs", "html"];

// Path .md relativo al repo -> path .html relativo al mirror, o null si está fuera del set.
export function outPathFor(relMd) {
	const p = relMd.replaceAll("\\", "/");
	if (p === "README.md") return "index.html";
	if (!p.startsWith("docs/") || !p.endsWith(".md")) return null;
	if (p.startsWith("docs/conversaciones/") || p.startsWith("docs/html/")) return null;
	return `${p.slice("docs/".length, -".md".length)}.html`;
}

// Reescribe en el HTML renderizado los href relativos a .md dentro del set hacia sus equivalentes .html del mirror.
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

// Regla del lado fuente: el Markdown dentro del set linkea a Markdown; el mirror (no el autor)
// es dueño de la reescritura .md -> .html. Un href relativo a .html cuyo target tenga un gemelo
// .md dentro del set (directamente o a través del mirror docs/html) es un error de fuente que este script no puede arreglar — hay que reportarlo.
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

// Descubre el set fuente: README.md raíz + docs/**/*.md menos los subárboles excluidos.
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

// Lista cada .html bajo el mirror como paths relativos al mirror.
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

// Sincroniza el mirror bajo `root`. check:true reporta drift sin tocar el disco.
// Devuelve { written, deleted, stale } (paths relativos al mirror).
export function syncDocsHtml(root, opts = {}) {
	const check = !!opts.check;
	const set = discoverSet(root);
	const mirrorAbs = path.join(root, ...MIRROR);
	const written = [];
	const deleted = [];
	const stale = [];
	const badHrefs = [];

	const rootPackageJsonPath = path.join(root, "package.json");
	const rootPackageName = fs.existsSync(rootPackageJsonPath)
		? JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8")).name
		: undefined;
	const expected = new Map();
	for (const rel of set) {
		const md = fs.readFileSync(path.join(root, rel), "utf8");
		const kicker = rel === "README.md" ? (rootPackageName ?? path.basename(root)) : path.posix.dirname(rel);
		const rendered = renderMarkdownToHtml(md, { title: path.posix.basename(rel), kicker });
		// Escaneá ANTES de rewriteHrefs: después, todo link correcto a .md dentro del set también se verá como .html.
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
