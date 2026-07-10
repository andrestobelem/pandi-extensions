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

async function main() {
	const entries = await fs.readdir(TUI_DIR, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => entry.name)
		.sort();

	check("tui TS files discovered", files.length > 0, TUI_DIR);

	for (const file of files) {
		const source = await fs.readFile(path.join(TUI_DIR, file), "utf8");
		const importsLifecycle = LIFECYCLE_IMPORT_RE.test(source);
		const allowed = ALLOWED_LIFECYCLE_IMPORTS.has(file);
		if (allowed) {
			check(`${file}: allowlisted lifecycle import`, importsLifecycle, "expected ../lifecycle import");
		} else {
			check(`${file}: does not import lifecycle`, !importsLifecycle, source.match(LIFECYCLE_IMPORT_RE)?.[0] ?? "");
		}
	}

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
