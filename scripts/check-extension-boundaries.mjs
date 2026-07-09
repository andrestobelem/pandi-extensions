#!/usr/bin/env node
// Verifica que los archivos runtime de una extensión no importen código desde
// otra extensión. `extensions/shared/` queda reservado para harness de tests.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STATIC_IMPORT_RE = /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function isInsidePath(candidate, root) {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function listRuntimeTsFiles(dir, packageRoot = dir) {
	if (!fs.existsSync(dir)) return [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const relativeParts = path.relative(packageRoot, fullPath).split(path.sep);
			if (relativeParts.includes("tests") || relativeParts.includes("node_modules")) continue;
			files.push(...listRuntimeTsFiles(fullPath, packageRoot));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts")) files.push(fullPath);
	}
	return files.sort();
}

function importSpecifiers(source) {
	const specs = [];
	for (const regex of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
		regex.lastIndex = 0;
		for (const match of source.matchAll(regex)) specs.push(match[1]);
	}
	return specs;
}

function packageNameForPath(extensionsDir, candidate) {
	if (!isInsidePath(candidate, extensionsDir)) return "(outside extensions)";
	const [packageName] = path.relative(extensionsDir, candidate).split(path.sep);
	return packageName || "(extensions root)";
}

export function findRuntimeBoundaryViolations({ root = REPO, extensionsDir = path.join(root, "extensions") } = {}) {
	if (!fs.existsSync(extensionsDir)) return [];
	const packages = fs
		.readdirSync(extensionsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== "shared")
		.map((entry) => ({ name: entry.name, root: path.join(extensionsDir, entry.name) }))
		.sort((a, b) => a.name.localeCompare(b.name));

	const violations = [];
	for (const pkg of packages) {
		for (const file of listRuntimeTsFiles(pkg.root)) {
			const source = fs.readFileSync(file, "utf8");
			for (const specifier of importSpecifiers(source)) {
				if (!specifier.startsWith(".")) continue;
				const target = path.resolve(path.dirname(file), specifier);
				if (isInsidePath(target, pkg.root)) continue;
				violations.push({
					file,
					relativeFile: path.relative(root, file),
					specifier,
					fromPackage: pkg.name,
					toPackage: packageNameForPath(extensionsDir, target),
				});
			}
		}
	}
	return violations;
}

export function formatBoundaryViolations(violations) {
	return violations
		.map(
			(violation) =>
				`${violation.relativeFile}: ${violation.fromPackage} imports ${violation.specifier} (${violation.toPackage})`,
		)
		.join("\n");
}

function main() {
	const violations = findRuntimeBoundaryViolations();
	if (violations.length === 0) {
		console.log("[check-extension-boundaries] extension runtime boundaries OK");
		return;
	}
	console.error("[check-extension-boundaries] cross-extension runtime imports found:");
	console.error(formatBoundaryViolations(violations));
	process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
