#!/usr/bin/env node
/**
 * Verifica la paridad del catálogo de extensiones del README y los links locales de Markdown.
 *
 * Esto es intencionalmente de solo lectura. Detecta drift barato de documentación que,
 * de otro modo, solo aparece durante el onboarding: counts de extensiones stale,
 * filas faltantes en el catálogo del README y links relativos rotos en docs/skills del repo.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function readText(file) {
	return fs.readFileSync(file, "utf8");
}

function walk(repoRoot, dir, { include, skipDir }) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const rel = path.relative(repoRoot, full);
		if (entry.isDirectory()) {
			if (!skipDir(rel)) out.push(...walk(repoRoot, full, { include, skipDir }));
		} else if (include(rel)) {
			out.push(full);
		}
	}
	return out;
}

function extensionDirNames(repoRoot) {
	// Fuente de verdad: los dirs extensions/pandi y extensions/pandi-* (excluyendo el
	// harness de tests `shared` y el package solo-temas `pandi-theme`). Cubre tanto las
	// extensiones Pi cargadas vía pi.extensions como los hosts portables de Ultracode
	// (pandi-ultracode-*), que viven en el repo como packages pero no se cargan con Pi.
	const extDir = path.join(repoRoot, "extensions");
	return fs
		.readdirSync(extDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.filter((name) => name === "pandi" || name.startsWith("pandi-"))
		.filter((name) => name !== "pandi-theme")
		.sort();
}

function checkReadmeCatalog(repoRoot, failures) {
	const readme = readText(path.join(repoRoot, "README.md"));
	const extensions = extensionDirNames(repoRoot);
	const uniqueExtensions = [...new Set(extensions)].sort();
	const count = uniqueExtensions.length;

	const headline =
		readme.match(/\*\*A suite of (\d+) extensions\s+for\s+\[Pi\]/) ??
		readme.match(/\*\*Una suite de (\d+) extensiones(?:\s+más un tema)?\s+para\s+\[Pi\]/);
	if (!headline) {
		failures.push("README headline extension count is missing");
	} else if (Number(headline[1]) !== count) {
		failures.push(`README headline says ${headline[1]} extensions, extensions dir has ${count}`);
	}

	const catalogIntro =
		readme.match(/All (\d+) extensions\s+load by default from the `pi\.extensions` field/) ??
		readme.match(/Las (\d+) extensiones del repo\s+se listan/);
	if (!catalogIntro) {
		failures.push("README catalog intro extension count is missing");
	} else if (Number(catalogIntro[1]) !== count) {
		failures.push(`README catalog intro says ${catalogIntro[1]} extensions, extensions dir has ${count}`);
	}

	for (const name of uniqueExtensions) {
		if (!readme.includes(`**${name}**`)) failures.push(`README catalog missing row for ${name}`);
	}
}

function markdownFilesToCheck(repoRoot) {
	const roots = ["README.md", "AGENTS.md", "CLAUDE.md", "docs", ".pi/skills", ".claude/skills"];
	const files = [];
	for (const root of roots) {
		const full = path.join(repoRoot, root);
		if (!fs.existsSync(full)) continue;
		const stat = fs.statSync(full);
		if (stat.isFile()) {
			if (root.endsWith(".md")) files.push(full);
			continue;
		}
		files.push(
			...walk(repoRoot, full, {
				include: (rel) => rel.endsWith(".md"),
				skipDir: (rel) => rel === "docs/html" || rel.includes(`${path.sep}node_modules${path.sep}`),
			}),
		);
	}
	return files.sort();
}

export function stripCodeSpans(line) {
	return line.replace(/`[^`]*`/g, "");
}

export function extractMarkdownLinks(text) {
	const links = [];
	const lines = text.split(/\r?\n/);
	let inFence = false;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const rawLine = lines[lineIndex];
		if (/^\s*```/.test(rawLine)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const line = stripCodeSpans(rawLine);
		const regex = /(?<!!\[)(?:\[[^\]\n]+\])\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
		for (const match of line.matchAll(regex)) links.push({ href: match[1], line: lineIndex + 1 });
	}
	return links;
}

function isExternalOrSpecial(href) {
	return (
		href.startsWith("http://") ||
		href.startsWith("https://") ||
		href.startsWith("mailto:") ||
		href.startsWith("#") ||
		href.startsWith("/")
	);
}

function decodePathname(href) {
	const withoutAnchor = href.split("#")[0];
	if (!withoutAnchor) return "";
	try {
		return decodeURIComponent(withoutAnchor);
	} catch {
		return withoutAnchor;
	}
}

function checkLinks(repoRoot, failures) {
	for (const file of markdownFilesToCheck(repoRoot)) {
		const text = readText(file);
		const base = path.dirname(file);
		const relFile = path.relative(repoRoot, file);
		for (const { href, line } of extractMarkdownLinks(text)) {
			if (isExternalOrSpecial(href)) continue;
			const targetPath = decodePathname(href);
			if (!targetPath) continue;
			const target = path.resolve(base, targetPath);
			if (!target.startsWith(repoRoot + path.sep) && target !== repoRoot) continue;
			if (!fs.existsSync(target)) failures.push(`${relFile}:${line} broken relative link: ${href}`);
		}
	}
}

function checkKnownStaleDocText(repoRoot, failures) {
	const ag = readText(path.join(repoRoot, "AGENTS.md"));
	if (ag.includes("tests/<extension>/integration/")) {
		failures.push(
			"AGENTS.md still references tests/<extension>/integration/ instead of extensions/<extension>/tests/integration/",
		);
	}
}

export function checkDocCatalogAndLinks(repoRoot = REPO_ROOT) {
	const root = path.resolve(repoRoot);
	const failures = [];
	checkReadmeCatalog(root, failures);
	checkKnownStaleDocText(root, failures);
	checkLinks(root, failures);
	return failures;
}

function main() {
	const failures = checkDocCatalogAndLinks(REPO_ROOT);

	if (failures.length > 0) {
		console.error(`doc catalog/link check failed (${failures.length})`);
		for (const failure of failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log("doc catalog/link check passed");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
