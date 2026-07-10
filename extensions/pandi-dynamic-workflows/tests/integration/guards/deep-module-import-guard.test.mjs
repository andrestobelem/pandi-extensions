/**
 * Guardrail: inversas de acoplamiento intencional post-migración deep-module.
 *
 * - runtime no importa surface (paths/transform viven en lib/)
 * - runtime no importa tui (engine sin dependencia de presentación)
 * - tui no importa surface (discovery vía lib/tui-discovery-deps)
 * - lifecycle no importa tui (widget vía lib/workflow-widget-deps; status en lifecycle/)
 * - lib no importa runtime (run-state y run-summary viven en lib/)
 * - ultracode no importa runtime (solo surface/lib para prompts y toggles)
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
		name: "runtime does not import tui",
		dir: "runtime",
		importRe: /from\s+["']\.\.\/tui(?:\/[^"']+)?["']/,
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
	{
		name: "lib does not import runtime",
		dir: "lib",
		importRe: /from\s+["']\.\.\/runtime(?:\/[^"']+)?["']/,
	},
	{
		name: "ultracode does not import runtime",
		dir: "ultracode",
		importRe: /from\s+["']\.\.\/runtime(?:\/[^"']+)?["']/,
	},
	{
		name: "observe does not import runtime",
		dir: "observe",
		importRe: /from\s+["']\.\.\/runtime(?:\/[^"']+)?["']/,
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

function importStatements(source) {
	const statements = [];
	let current = "";
	for (const line of source.split("\n")) {
		if (!current && /^import\b/.test(line)) current = line;
		else if (current) current += `\n${line}`;
		if (current && /^import\s+["'][^"']+["'];?\s*$/.test(current)) {
			statements.push(current);
			current = "";
		} else if (current && /\bfrom\s+["'][^"']+["'];?\s*$/.test(current)) {
			statements.push(current);
			current = "";
		}
	}
	if (current) statements.push(current);
	return statements;
}

function hasForbiddenImport(source, importRe, skipTypeOnly) {
	if (!skipTypeOnly) return source.match(importRe)?.[0] ?? "";
	for (const statement of importStatements(source)) {
		if (/^import\s+type\b/.test(statement)) continue;
		const match = statement.match(importRe);
		if (match) return match[0];
	}
	return "";
}

async function main() {
	for (const rule of RULES) {
		const targetDir = path.join(PACKAGE_DIR, rule.dir);
		const files = (await listTsFiles(targetDir)).sort();
		check(`${rule.name}: TS files discovered`, files.length > 0, targetDir);

		for (const file of files) {
			const rel = path.relative(PACKAGE_DIR, file);
			const source = await fs.readFile(file, "utf8");
			const match = hasForbiddenImport(source, rule.importRe, rule.skipTypeOnly);
			check(`${rel}: ${rule.name}`, !match, match ?? "");
		}
	}

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
