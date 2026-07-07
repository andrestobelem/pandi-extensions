#!/usr/bin/env node
// sync-doc-mirrors.mjs — motor genérico de mirrors md ↔ html para cualquier repo.
//
// El caller declara entries {source, out?, kicker?, tokens?, css?, artifact?} (a mano, vía un
// manifest mirrors.json, o calculadas por un wrapper con su propia política de discovery)
// y este módulo se encarga del mecanismo: renderiza cada fuente con el conversor pandi
// (markdown-to-html.mjs), reescribe los links .md dentro del set hacia sus mirrors .html,
// remapea los srcs de assets cuando el out vive en otro directorio, escribe SOLO si el contenido
// cambió (así el recordatorio de redeploy de artifacts no se repite en no-ops), reporta
// drift en modo --check sin tocar el disco, y poda .html huérfanos en pruneDirs.
//
// Uso CLI:
//   node sync-doc-mirrors.mjs --config mirrors.json [--root dir] [--check]
//
// El manifest es {"mirrors": [{source, out?, kicker?, tokens?, css?, artifact?}]}; un
// mirrors.local.json hermano (gitignoreable, docs personales) se mergea si existe.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { renderMarkdownToHtml } from "./markdown-to-html.mjs";

const toPosix = (p) => p.replaceAll("\\", "/");

function isLocalRelativeUrl(url) {
	return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("#") && !url.startsWith("/");
}

function splitUrlSuffix(url) {
	const cuts = [url.indexOf("?"), url.indexOf("#")].filter((i) => i >= 0);
	if (!cuts.length) return [url, ""];
	const cut = Math.min(...cuts);
	return [url.slice(0, cut), url.slice(cut)];
}

// Ruta out por defecto: la fuente con .md reemplazado por .html (mirror hermano).
function defaultOut(source) {
	return `${toPosix(source).replace(/\.md$/i, "")}.html`;
}

// Reescribe hrefs relativos a .md dentro del set hacia el out de su mirror, relativo al
// out del documento actual. Los anchors se preservan; las URLs externas y los targets fuera del set, también.
export function rewriteHrefs(html, fromSource, mapping) {
	const fromOut = mapping.get(toPosix(fromSource));
	if (!fromOut) return html;
	return html.replace(/href="([^"]+)"/g, (all, href) => {
		if (!isLocalRelativeUrl(href)) return all;
		const [target, anchor] = href.split("#");
		if (!target.endsWith(".md")) return all;
		const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(fromSource)), target));
		const toOut = mapping.get(resolved);
		if (!toOut) return all;
		const rel = path.posix.relative(path.posix.dirname(fromOut), toOut) || path.posix.basename(toOut);
		return `href="${rel}${anchor ? `#${anchor}` : ""}"`;
	});
}

// Remapea srcs relativos (imágenes, etc.) para que sigan resolviendo desde la ubicación
// del out; cuando el out es hermano de la fuente, el remapeo es identidad.
export function rewriteAssetSrcs(html, fromSource, fromOut) {
	const fromDir = path.posix.dirname(toPosix(fromSource));
	const outDir = path.posix.dirname(toPosix(fromOut));
	if (fromDir === outDir) return html;
	return html.replace(/(\s)src="([^"]+)"/g, (all, prefix, src) => {
		if (!isLocalRelativeUrl(src)) return all;
		const [target, suffix] = splitUrlSuffix(src);
		if (!target) return all;
		const assetRel = path.posix.normalize(path.posix.join(fromDir, target));
		const rel = path.posix.relative(outDir, assetRel) || path.posix.basename(assetRel);
		return `${prefix}src="${rel}${suffix}"`;
	});
}

// Regla del lado fuente: el Markdown dentro del set linkea a Markdown; el mirror es dueño
// de la reescritura .md -> .html. Un href relativo a .html cuyo target sea el out de un
// mirror (o cuyo gemelo .md hermano esté en el set) es un error de fuente a reportar.
export function findBadSourceHrefs(html, fromSource, mapping) {
	const outToSource = new Map();
	for (const [source, out] of mapping) outToSource.set(out, source);
	const bad = [];
	for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
		if (!isLocalRelativeUrl(href)) continue;
		const [target] = href.split("#");
		if (!target.endsWith(".html")) continue;
		const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(fromSource)), target));
		const twin =
			outToSource.get(resolved) ??
			(mapping.has(`${resolved.slice(0, -".html".length)}.md`) ? `${resolved.slice(0, -".html".length)}.md` : null);
		if (twin) bad.push({ file: toPosix(fromSource), href, twin });
	}
	return bad;
}

// Lee un manifest {"mirrors": [...]} y mergea el mirrors.local.json hermano si existe.
export function loadManifest(configAbsPath) {
	const entries = JSON.parse(fs.readFileSync(configAbsPath, "utf8")).mirrors ?? [];
	const localPath = path.join(path.dirname(configAbsPath), "mirrors.local.json");
	if (fs.existsSync(localPath)) entries.push(...(JSON.parse(fs.readFileSync(localPath, "utf8")).mirrors ?? []));
	return entries;
}

// Lista cada .html bajo un directorio como paths relativos a ese directorio.
function listHtml(dirAbs) {
	const out = [];
	const walk = (rel) => {
		const abs = path.join(dirAbs, rel);
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

// Sincroniza los mirrors bajo `root`. check:true reporta drift sin tocar el disco.
// Devuelve { written, unchanged, deleted, stale, skipped, redeploys, badHrefs }
// (outs relativos al root; deleted relativo a su pruneDir).
export function syncDocMirrors(root, opts = {}) {
	const check = !!opts.check;
	const entries = opts.entries ?? [];
	const pruneDirs = opts.pruneDirs ?? [];

	const mapping = new Map();
	for (const e of entries) {
		if (fs.existsSync(path.join(root, e.source)))
			mapping.set(toPosix(e.source), toPosix(e.out ?? defaultOut(e.source)));
	}

	const report = { written: [], unchanged: [], deleted: [], stale: [], skipped: [], redeploys: [], badHrefs: [] };

	for (const entry of entries) {
		const source = toPosix(entry.source);
		const out = mapping.get(source);
		if (!out) {
			report.skipped.push(source);
			continue;
		}
		const md = fs.readFileSync(path.join(root, source), "utf8");
		const tokensCss = entry.tokens ? fs.readFileSync(path.join(root, entry.tokens), "utf8") : undefined;
		const css = entry.css ? fs.readFileSync(path.join(root, entry.css), "utf8") : undefined;
		const rendered = renderMarkdownToHtml(md, {
			title: path.posix.basename(source),
			kicker: entry.kicker,
			tokensCss,
			css,
		});
		// Escaneá ANTES de rewriteHrefs: después, todo link correcto a .md dentro del set también se verá como .html.
		report.badHrefs.push(...findBadSourceHrefs(rendered, source, mapping));
		const html = rewriteAssetSrcs(rewriteHrefs(rendered, source, mapping), source, out);

		const outAbs = path.join(root, out);
		const have = fs.existsSync(outAbs) ? fs.readFileSync(outAbs, "utf8") : null;
		if (have === html) {
			report.unchanged.push(out);
			continue;
		}
		if (check) {
			report.stale.push(out);
			continue;
		}
		fs.mkdirSync(path.dirname(outAbs), { recursive: true });
		fs.writeFileSync(outAbs, html);
		report.written.push(out);
		if (entry.artifact) report.redeploys.push({ source, artifact: entry.artifact });
	}

	const expectedOuts = new Set(mapping.values());
	for (const dirRel of pruneDirs) {
		const dirAbs = path.join(root, dirRel);
		for (const rel of listHtml(dirAbs)) {
			const outRel = path.posix.join(toPosix(dirRel), rel);
			if (expectedOuts.has(outRel)) continue;
			if (check) report.stale.push(outRel);
			else {
				fs.rmSync(path.join(dirAbs, rel));
				report.deleted.push(rel);
			}
		}
	}

	return report;
}

function parseCliArgs(argv) {
	const args = { config: "mirrors.json", root: process.cwd(), check: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--config") args.config = argv[++i];
		else if (a === "--root") args.root = argv[++i];
		else if (a === "--check") args.check = true;
		else if (a === "-h" || a === "--help") return { help: true };
		else throw new Error(`flag desconocida: ${a}`);
	}
	return args;
}

function main() {
	let args;
	try {
		args = parseCliArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`[sync-doc-mirrors] ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
	if (args.help) {
		console.log("Uso: sync-doc-mirrors.mjs --config mirrors.json [--root dir] [--check]");
		process.exit(0);
	}
	const root = path.resolve(args.root);
	const entries = loadManifest(path.resolve(root, args.config));
	const report = syncDocMirrors(root, { entries, check: args.check });

	if (report.badHrefs.length) {
		console.error(
			`[sync-doc-mirrors] ✗ ${report.badHrefs.length} link(s) .html en fuentes Markdown con gemelo .md dentro del set:`,
		);
		for (const b of report.badHrefs)
			console.error(`[sync-doc-mirrors]   ${b.file}: ${b.href} -> linkeá la fuente (${b.twin})`);
		process.exit(1);
	}
	for (const s of report.skipped) console.warn(`[sync-doc-mirrors] salto: ${s} (no existe)`);
	if (args.check) {
		if (report.stale.length) {
			console.error(`[sync-doc-mirrors] ✗ drift (${report.stale.length}): ${report.stale.join(", ")}`);
			console.error("[sync-doc-mirrors]   corré el sync y commiteá el resultado");
			process.exit(1);
		}
		console.log("[sync-doc-mirrors] ✓ mirrors en sync");
		return;
	}
	for (const f of report.written) console.log(`[sync-doc-mirrors] escribí ${f}`);
	for (const f of report.deleted) console.log(`[sync-doc-mirrors] podé ${f}`);
	for (const r of report.redeploys)
		console.log(`[sync-doc-mirrors]   ↳ redeploy artifact ${r.artifact.favicon ?? ""} ${r.artifact.url}`);
	if (!report.written.length && !report.deleted.length) console.log("[sync-doc-mirrors] mirrors ya en sync");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
