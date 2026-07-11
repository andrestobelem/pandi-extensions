#!/usr/bin/env node
/**
 * Guardián: las suites de integración no reimplementan esbuild inline.
 *
 * El bootstrap compartido vive en extensions/shared/test/harness.mjs; helpers
 * específicos de DWF en ../dwf-test-support.mjs. Cualquier spawn de esbuild
 * fuera de esos dos archivos es regresión de Fase 4.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTEGRATION_ROOT = path.resolve(__dirname, "..");
const ALLOWED = new Set([
	path.join(INTEGRATION_ROOT, "dwf-test-support.mjs"),
	path.join(INTEGRATION_ROOT, "..", "..", "..", "shared", "test", "harness.mjs"),
]);

const { check, counts } = createChecker();

const FORBIDDEN = [
	/spawnSync\s*\(\s*["']npx["']/,
	/\bnpx\s+--(?:no-install|yes)\s+esbuild\b/,
	/\besbuild\s+[^\n]+--bundle\b/,
];

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const abs = path.join(dir, name);
		const st = statSync(abs);
		if (st.isDirectory()) {
			if (name === "fixtures") continue;
			walk(abs, out);
			continue;
		}
		if (name.endsWith(".mjs") || name.endsWith(".ts")) out.push(abs);
	}
	return out;
}

function main() {
	const offenders = [];
	for (const file of walk(INTEGRATION_ROOT)) {
		if (ALLOWED.has(path.resolve(file))) continue;
		const text = readFileSync(file, "utf8");
		for (const re of FORBIDDEN) {
			if (re.test(text)) {
				offenders.push(`${path.relative(INTEGRATION_ROOT, file)}: ${re}`);
				break;
			}
		}
	}
	check("no integration file spawns esbuild inline", offenders.length === 0, offenders.join("\n"));

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const f of counts.failures) console.error(`- ${f}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main();
