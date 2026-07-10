/**
 * Guardrail: inversas de acoplamiento intencional post-migración deep-module.
 *
 * - runtime no importa surface (paths/transform viven en lib/)
 * - tui no importa surface (discovery vía lib/tui-discovery-deps)
 * - lifecycle no importa tui (widget vía lib/workflow-widget-deps; status en lifecycle/)
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/guards/deep-module-import-guard.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(__dirname, "..", "..", "..");

const RULES = [
	{
		name: "runtime does not import surface",
		dir: "runtime",
		importRe: /from\s+["']\.\.\/surface(?:\/[^"']+)?["']/,
	},
	{
		name: "tui does not import surface",
		dir: "tui",
		importRe: /from\s+["']\.\.\/surface(?:\/[^"']+)?["']/,
	},
	{
		name: "lifecycle does not import tui",
		dir: "lifecycle",
		importRe: /from\s+["']\.\.\/tui(?:\/[^"']+)?["']/,
	},
];

let failures = 0;
function check(name, ok, detail = "") {
	if (ok) {
		console.log(`PASS: ${name}`);
	} else {
		failures += 1;
		console.log(`FAIL: ${name}${detail ? `  [${detail}]` : ""}`);
	}
}

async function listTsFiles(dir) {
	const results = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await listTsFiles(fullPath)));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			results.push(fullPath);
		}
	}
	return results;
}

async function main() {
	for (const rule of RULES) {
		const targetDir = path.join(PACKAGE_DIR, rule.dir);
		const files = (await listTsFiles(targetDir)).sort();
		check(`${rule.name}: TS files discovered`, files.length > 0, targetDir);

		for (const file of files) {
			const rel = path.relative(PACKAGE_DIR, file);
			const source = await fs.readFile(file, "utf8");
			const match = source.match(rule.importRe);
			check(`${rel}: ${rule.name}`, !match, match?.[0] ?? "");
		}
	}

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
