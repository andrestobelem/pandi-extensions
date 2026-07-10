/**
 * Guardrail: tui no importa lifecycle salvo en open.ts (orquestación del dashboard).
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/guards/tui-lifecycle-import-guard.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TUI_DIR = path.resolve(__dirname, "..", "..", "..", "tui");
const LIFECYCLE_IMPORT_RE = /from\s+["']\.\.\/lifecycle(?:\/[^"']+)?["']/;

const ALLOWED_LIFECYCLE_IMPORTS = new Set(["open.ts"]);

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
	const files = (await listTsFiles(TUI_DIR)).sort();
	check("tui TS files discovered", files.length > 0, TUI_DIR);

	for (const file of files) {
		const rel = path.relative(TUI_DIR, file);
		const source = await fs.readFile(file, "utf8");
		const importsLifecycle = LIFECYCLE_IMPORT_RE.test(source);
		const allowed = ALLOWED_LIFECYCLE_IMPORTS.has(rel);
		if (allowed) {
			check(`${rel}: allowlisted lifecycle import`, importsLifecycle, "expected ../lifecycle import");
		} else {
			check(`${rel}: does not import lifecycle`, !importsLifecycle, source.match(LIFECYCLE_IMPORT_RE)?.[0] ?? "");
		}
	}

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
