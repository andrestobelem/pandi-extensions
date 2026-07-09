#!/usr/bin/env node
// Verifica que el `files[]` de cada extensión cubra los archivos fuente que
// deben llegar al tarball standalone. No reemplaza `npm pack`; evita olvidos
// mecánicos en paquetes con listas explícitas.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SHIPPABLE_DIRS = new Set(["primitives", "scaffolds", "scripts", "skills", "themes"]);
const IGNORED_DIRS = new Set(["node_modules", "tests"]);

function slash(relativePath) {
	return relativePath.split(path.sep).join("/");
}

function listFiles(dir, root = dir) {
	if (!fs.existsSync(dir)) return [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (IGNORED_DIRS.has(entry.name)) continue;
			files.push(...listFiles(fullPath, root));
			continue;
		}
		if (entry.isFile()) files.push(slash(path.relative(root, fullPath)));
	}
	return files.sort();
}

function escapeRegex(value) {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternToRegex(pattern) {
	const source = slash(pattern).split("*").map(escapeRegex).join("[^/]*");
	return new RegExp(`^${source}$`);
}

function filesEntryCovers(relativePath, entry) {
	const normalized = slash(entry).replace(/\/$/, "");
	if (relativePath === normalized) return true;
	if (!normalized.includes("*")) return relativePath.startsWith(`${normalized}/`);
	return globPatternToRegex(normalized).test(relativePath);
}

function packageFilesCover(relativePath, filesEntries) {
	return filesEntries.some((entry) => filesEntryCovers(relativePath, entry));
}

function shippableFiles(packageRoot) {
	const entries = fs.readdirSync(packageRoot, { withFileTypes: true });
	const required = [];
	for (const entry of entries) {
		if (entry.isFile()) {
			if (entry.name === "README.md" || entry.name.endsWith(".ts")) required.push(entry.name);
			continue;
		}
		if (entry.isDirectory() && SHIPPABLE_DIRS.has(entry.name)) {
			required.push(...listFiles(path.join(packageRoot, entry.name), packageRoot));
		}
	}
	return required.sort();
}

export function findPackageFilesViolations({ root = REPO, extensionsDir = path.join(root, "extensions") } = {}) {
	if (!fs.existsSync(extensionsDir)) return [];
	const violations = [];
	for (const entry of fs
		.readdirSync(extensionsDir, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name === "shared") continue;
		const packageRoot = path.join(extensionsDir, entry.name);
		const packageJsonPath = path.join(packageRoot, "package.json");
		if (!fs.existsSync(packageJsonPath)) continue;
		const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		const filesEntries = Array.isArray(pkg.files) ? pkg.files : [];
		for (const relativePath of shippableFiles(packageRoot)) {
			if (packageFilesCover(relativePath, filesEntries)) continue;
			violations.push({
				packageDir: entry.name,
				packageName: pkg.name,
				relativePath,
				packageJson: slash(path.relative(root, packageJsonPath)),
			});
		}
	}
	return violations;
}

export function formatPackageFilesViolations(violations) {
	return violations
		.map((violation) => `${violation.packageJson}: files[] does not include ${violation.relativePath}`)
		.join("\n");
}

function main() {
	const violations = findPackageFilesViolations();
	if (violations.length === 0) {
		console.log("[check-package-files] extension package files OK");
		return;
	}
	console.error("[check-package-files] missing files[] coverage:");
	console.error(formatPackageFilesViolations(violations));
	process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
