#!/usr/bin/env node
// sync-docs-html.mjs — espeja los docs humanos (README.md raíz + docs/**/*.md, salvo el
// transitorio docs/conversaciones/) en `docs/html/` como HTML COMMITTEADO y navegable.
//
// Este script es la POLÍTICA del repo (qué archivos entran al set, dónde sale cada uno y
// qué kicker lleva); el MECANISMO (render pandi, reescritura de links/assets, write
// solo-si-cambió, check sin writes, poda de huérfanos, guard de hrefs .html) vive en
// extensions/pandi-docs/scripts/sync-doc-mirrors.mjs y es reutilizable por otros repos.
//
// Mapeo: README.md -> docs/html/index.html; docs/<path>.md -> docs/html/<path>.html.
// `npm test` corre el --check, así que el drift rompe la compuerta.
//
// Uso:
//   node scripts/sync-docs-html.mjs           # escribe/refresca el mirror (y poda huérfanos)
//   node scripts/sync-docs-html.mjs --check   # solo verifica; sale con 1 si hay drift (sin writes)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCheckOnly } from "./lib/cli-args.mjs";
import { readJsonFile } from "./lib/json-io.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(REPO, "extensions", "pandi-docs", "scripts", "sync-doc-mirrors.mjs");
const engine = await import(pathToFileURL(ENGINE).href);

const MIRROR = "docs/html";

// Path .md relativo al repo -> path .html relativo al mirror, o null si está fuera del set.
export function outPathFor(relMd) {
	const p = relMd.replaceAll("\\", "/");
	if (p === "README.md") return "index.html";
	if (!p.startsWith("docs/") || !p.endsWith(".md")) return null;
	if (p.startsWith("docs/conversaciones/") || p.startsWith("docs/html/")) return null;
	return `${p.slice("docs/".length, -".md".length)}.html`;
}

// Set fuente -> mapping repo-relativo {source -> out} que consume el motor.
function mappingFor(set) {
	const mapping = new Map();
	for (const rel of set) mapping.set(rel, path.posix.join(MIRROR, outPathFor(rel)));
	return mapping;
}

// Adaptador con la firma histórica: reescribe srcs relativos hacia rutas válidas desde el mirror.
export function rewriteAssetSrcs(html, fromMd) {
	const out = outPathFor(fromMd);
	if (!out) return html;
	return engine.rewriteAssetSrcs(html, fromMd, path.posix.join(MIRROR, out));
}

// Adaptador con la firma histórica: reescribe hrefs .md dentro del set hacia su mirror .html.
export function rewriteHrefs(html, fromMd, set) {
	if (!outPathFor(fromMd)) return html;
	return engine.rewriteHrefs(html, fromMd, mappingFor(set));
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

// Kicker por archivo: el README raíz lleva el nombre del package; el resto, su directorio.
function kickerFor(rel, root) {
	if (rel !== "README.md") return path.posix.dirname(rel);
	const pkgPath = path.join(root, "package.json");
	const pkgName = fs.existsSync(pkgPath) ? readJsonFile(pkgPath).name : undefined;
	return pkgName ?? path.basename(root);
}

// Quita el prefijo del mirror para conservar el reporte histórico (paths relativos al mirror).
const mirrorRel = (outRel) => (outRel.startsWith(`${MIRROR}/`) ? outRel.slice(MIRROR.length + 1) : outRel);

// Sincroniza el mirror bajo `root`. check:true reporta drift sin tocar el disco.
// Devuelve { written, deleted, stale, badHrefs } (paths relativos al mirror).
export function syncDocsHtml(root, opts = {}) {
	const entries = [...discoverSet(root)].map((source) => ({
		source,
		out: path.posix.join(MIRROR, outPathFor(source)),
		kicker: kickerFor(source, root),
	}));
	const report = engine.syncDocMirrors(root, { entries, check: !!opts.check, pruneDirs: [MIRROR] });
	return {
		written: report.written.map(mirrorRel),
		deleted: report.deleted,
		stale: report.stale.map(mirrorRel),
		badHrefs: report.badHrefs,
	};
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const check = parseCheckOnly(process.argv.slice(2));
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
