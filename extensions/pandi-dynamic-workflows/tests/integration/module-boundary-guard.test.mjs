/**
 * Guardrail de arquitectura para pandi-dynamic-workflows.
 *
 * index.ts es el facade público + engine. Los siblings no deben usarlo como barrel
 * de contratos o constantes: eso reintroduce ciclos ESM difíciles de razonar. Las
 * index.ts no tiene importadores internos: es facade público + activación.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "..", "..");

const ALLOWED_INDEX_IMPORTS = new Map();

let failures = 0;
function check(name, ok, detail = "") {
	if (ok) {
		console.log(`PASS: ${name}`);
	} else {
		failures += 1;
		console.log(`FAIL: ${name}${detail ? `  [${detail}]` : ""}`);
	}
}

function importStatementComplete(statement) {
	return /^import\s+["'][^"']+["'];?\s*$/.test(statement) || /\bfrom\s+["'][^"']+["'];?\s*$/.test(statement);
}

function importStatements(source) {
	const statements = [];
	let current = "";
	for (const line of source.split("\n")) {
		if (!current && /^import\b/.test(line)) current = line;
		else if (current) current += `\n${line}`;
		if (current && importStatementComplete(current)) {
			statements.push(current);
			current = "";
		}
	}
	if (current) statements.push(current);
	return statements;
}

function importsFromIndex(statement) {
	return (
		/^import\s+["']\.\/index\.js["'];?\s*$/.test(statement) || /\bfrom\s+["']\.\/index\.js["'];?\s*$/.test(statement)
	);
}

function importedNamesFromIndex(statements) {
	const names = [];
	for (const statement of statements) {
		if (!importsFromIndex(statement)) continue;
		if (/^import\s+type\b/.test(statement)) continue;
		const namedMatch = /^import\s+\{([\s\S]*?)\}\s+from\s+["']\.\/index\.js["'];?\s*$/.exec(statement);
		if (namedMatch) {
			for (const part of namedMatch[1].split(",")) {
				const name = part
					.trim()
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/)[0]
					?.trim();
				if (name) names.push(name);
			}
			continue;
		}
		const namespaceMatch = /^import\s+\*\s+as\s+([\w$]+)\s+from\s+["']\.\/index\.js["'];?\s*$/.exec(statement);
		if (namespaceMatch) {
			names.push(`* as ${namespaceMatch[1]}`);
			continue;
		}
		const defaultMatch = /^import\s+([\w$]+)(?:\s*,[\s\S]*)?\s+from\s+["']\.\/index\.js["'];?\s*$/.exec(statement);
		names.push(defaultMatch?.[1] ?? "<side-effect import>");
	}
	return names;
}

function scannerSelfCheck() {
	const source = `
import { runWorkflow } from "./index.js"
import {
	DynamicWorkflowToolParams as Params,
	type WorkflowRunState,
} from "./index.js";
import * as indexApi from "./index.js"
import defaultFacade from "./index.js";
import "./index.js"
import type { WorkflowRunResult } from "./index.js"
`;
	const statements = importStatements(source);
	const imported = importedNamesFromIndex(statements);
	check(
		"scanner: captures semicolon-less and multiline import statements",
		statements.length === 6,
		String(statements.length),
	);
	check("scanner: extracts named imports from index.ts", imported.includes("runWorkflow"), imported.join(", "));
	check(
		"scanner: extracts multiline named imports from index.ts",
		imported.includes("DynamicWorkflowToolParams"),
		imported.join(", "),
	);
	check(
		"scanner: flags namespace/default/side-effect imports from index.ts",
		["* as indexApi", "defaultFacade", "<side-effect import>"].every((name) => imported.includes(name)),
		imported.join(", "),
	);
	check(
		"scanner: ignores type-only imports from index.ts",
		!imported.includes("WorkflowRunResult"),
		imported.join(", "),
	);
}

async function main() {
	scannerSelfCheck();
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
			(statement) => /^import\s+type\b/.test(statement) && importsFromIndex(statement),
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
