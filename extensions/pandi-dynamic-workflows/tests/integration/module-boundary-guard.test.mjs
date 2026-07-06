/**
 * Guardrail de arquitectura para pandi-dynamic-workflows.
 *
 * index.ts es el facade público + engine. Los siblings no deben usarlo como barrel
 * de contratos o constantes: eso reintroduce ciclos ESM difíciles de razonar. Las
 * pocas importaciones runtime restantes son intencionales y explícitas: UI/lifecycle
 * llaman entry points del engine.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "..", "..");

const ALLOWED_INDEX_IMPORTS = new Map([
	["dashboard-orchestration.ts", new Set(["runWorkflow"])],
	["run-lifecycle.ts", new Set(["prepareWorkflowRun", "runWorkflow"])],
]);

let failures = 0;
function check(name, ok, detail = "") {
	if (ok) {
		console.log(`PASS: ${name}`);
	} else {
		failures += 1;
		console.log(`FAIL: ${name}${detail ? `  [${detail}]` : ""}`);
	}
}

function importStatements(source) {
	const statements = [];
	let current = "";
	for (const line of source.split("\n")) {
		if (!current && /^import\b/.test(line)) current = line;
		else if (current) current += `\n${line}`;
		if (current && /;\s*$/.test(line)) {
			statements.push(current);
			current = "";
		}
	}
	return statements;
}

function importedNamesFromIndex(statements) {
	const names = [];
	for (const statement of statements) {
		if (!/from\s+["']\.\/index\.js["'];\s*$/.test(statement)) continue;
		if (/^import\s+type\b/.test(statement)) continue;
		const match = /^import\s+\{([\s\S]*?)\}\s+from\s+["']\.\/index\.js["'];\s*$/.exec(statement);
		if (!match) continue;
		for (const part of match[1].split(",")) {
			const name = part
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)[0]
				?.trim();
			if (name) names.push(name);
		}
	}
	return names;
}

async function main() {
	const entries = await fs.readdir(EXTENSION_DIR, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "index.ts")
		.map((entry) => entry.name)
		.sort();

	check("extension TS files discovered", files.length > 0, EXTENSION_DIR);

	for (const file of files) {
		const source = await fs.readFile(path.join(EXTENSION_DIR, file), "utf8");
		const statements = importStatements(source);
		const typeImports = statements.filter(
			(statement) => /^import\s+type\b/.test(statement) && /from\s+["']\.\/index\.js["'];\s*$/.test(statement),
		);
		check(`${file}: does not import contracts from index.ts`, typeImports.length === 0, typeImports.join(" | "));

		const imported = importedNamesFromIndex(statements);
		const allowed = ALLOWED_INDEX_IMPORTS.get(file) ?? new Set();
		const unexpected = imported.filter((name) => !allowed.has(name));
		check(`${file}: only allowlisted runtime imports from index.ts`, unexpected.length === 0, unexpected.join(", "));

		const missing = [...allowed].filter((name) => !imported.includes(name));
		check(`${file}: allowlist documents actual index.ts imports`, missing.length === 0, missing.join(", "));
	}

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
