#!/usr/bin/env node
/**
 * Check README extension catalog parity and local Markdown links.
 *
 * This is intentionally read-only. It catches cheap documentation drift that
 * otherwise only appears during onboarding: stale extension counts, missing
 * README catalog rows, and broken relative links in repo docs/skills.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const README = path.join(REPO_ROOT, "README.md");
const ROOT_PACKAGE = path.join(REPO_ROOT, "package.json");

function readText(file) {
	return fs.readFileSync(file, "utf8");
}

function readJson(file) {
	return JSON.parse(readText(file));
}

function walk(dir, { include, skipDir }) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const rel = path.relative(REPO_ROOT, full);
		if (entry.isDirectory()) {
			if (!skipDir(rel)) out.push(...walk(full, { include, skipDir }));
		} else if (include(rel)) {
			out.push(full);
		}
	}
	return out;
}

function extensionNamesFromManifest() {
	const pkg = readJson(ROOT_PACKAGE);
	return (pkg.pi?.extensions ?? []).map((entry) => entry.match(/^\.\/extensions\/([^/]+)\//)?.[1]).filter(Boolean);
}

function checkReadmeCatalog(failures) {
	const readme = readText(README);
	const extensions = extensionNamesFromManifest();
	const uniqueExtensions = [...new Set(extensions)].sort();
	const count = uniqueExtensions.length;

	const headline =
		readme.match(/\*\*A suite of (\d+) extensions for \[Pi\]/) ??
		readme.match(/\*\*Una suite de (\d+) extensiones(?: más un tema)? para \[Pi\]/);
	if (!headline) {
		failures.push("README headline extension count is missing");
	} else if (Number(headline[1]) !== count) {
		failures.push(`README headline says ${headline[1]} extensions, package.json pi.extensions has ${count}`);
	}

	const catalogIntro =
		readme.match(/All (\d+) extensions load by default from the `pi\.extensions` field/) ??
		readme.match(/Las (\d+) extensiones de comando\/tool se cargan por defecto desde el campo `pi\.extensions`/);
	if (!catalogIntro) {
		failures.push("README catalog intro extension count is missing");
	} else if (Number(catalogIntro[1]) !== count) {
		failures.push(`README catalog intro says ${catalogIntro[1]} extensions, package.json pi.extensions has ${count}`);
	}

	for (const name of uniqueExtensions) {
		if (!readme.includes(`**${name}**`)) failures.push(`README catalog missing row for ${name}`);
	}
}

function markdownFilesToCheck() {
	const roots = ["README.md", "AGENTS.md", "CLAUDE.md", "docs", ".pi/skills", ".claude/skills"];
	const files = [];
	for (const root of roots) {
		const full = path.join(REPO_ROOT, root);
		if (!fs.existsSync(full)) continue;
		const stat = fs.statSync(full);
		if (stat.isFile()) {
			if (root.endsWith(".md")) files.push(full);
			continue;
		}
		files.push(
			...walk(full, {
				include: (rel) => rel.endsWith(".md"),
				skipDir: (rel) => rel === "docs/html" || rel.includes(`${path.sep}node_modules${path.sep}`),
			}),
		);
	}
	return files.sort();
}

function stripCodeSpans(line) {
	return line.replace(/`[^`]*`/g, "");
}

function extractMarkdownLinks(text) {
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

function checkLinks(failures) {
	for (const file of markdownFilesToCheck()) {
		const text = readText(file);
		const base = path.dirname(file);
		const relFile = path.relative(REPO_ROOT, file);
		for (const { href, line } of extractMarkdownLinks(text)) {
			if (isExternalOrSpecial(href)) continue;
			const targetPath = decodePathname(href);
			if (!targetPath) continue;
			const target = path.resolve(base, targetPath);
			if (!target.startsWith(REPO_ROOT + path.sep) && target !== REPO_ROOT) continue;
			if (!fs.existsSync(target)) failures.push(`${relFile}:${line} broken relative link: ${href}`);
		}
	}
}

function checkKnownStaleDocText(failures) {
	const ag = readText(path.join(REPO_ROOT, "AGENTS.md"));
	if (ag.includes("tests/<extension>/integration/")) {
		failures.push(
			"AGENTS.md still references tests/<extension>/integration/ instead of extensions/<extension>/tests/integration/",
		);
	}
}

function main() {
	const failures = [];
	checkReadmeCatalog(failures);
	checkKnownStaleDocText(failures);
	checkLinks(failures);

	if (failures.length > 0) {
		console.error(`doc catalog/link check failed (${failures.length})`);
		for (const failure of failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log("doc catalog/link check passed");
}

main();
