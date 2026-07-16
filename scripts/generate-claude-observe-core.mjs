#!/usr/bin/env node
// generate-claude-observe-core.mjs — bundlea de forma determinista el renderer canónico de
// reportes de run de pi (extensions/pandi-dynamic-workflows/observe/html.ts, un builder PURO
// model→HTML) en un módulo plain-JS autocontenido para los scripts del lado Claude:
//   .claude/scripts/lib/observe-core.mjs  (sincronizado a ~/.claude por sync-claude-global)
//
// El TS de pi es la FUENTE DE VERDAD. El .mjs es un artifact generado: no lo edites a mano —
// editá observe/*.ts y re-ejecutá esto. Un guard test (tests/.../claude-observe-core-parity)
// rebuildea y byte-compara para proteger contra drift.
//
// marked y sanitize-html quedan inlineados en el bundle (el runtime de ~/.claude/scripts no
// tiene node_modules), así el módulo es autocontenido igual que el resto de la lib.
//
// Uso:
//   node scripts/generate-claude-observe-core.mjs           # escribe el bundle
//   node scripts/generate-claude-observe-core.mjs --check   # verifica y sale con 1 si hay drift

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "observe", "html.ts");
const OUT = join(REPO_ROOT, ".claude", "scripts", "lib", "observe-core.mjs");

const BANNER = `// GENERATED FILE — do not edit by hand.
// Fuente canónica: extensions/pandi-dynamic-workflows/observe/html.ts (renderer puro de pi).
// Regenerar: node scripts/generate-claude-observe-core.mjs
// Guard: tests/integration/guards/claude-observe-core-parity.test.mjs`;

export function buildBundle() {
	const tmp = mkdtempSync(join(tmpdir(), "observe-core-"));
	try {
		const outfile = join(tmp, "observe-core.mjs");
		const result = spawnSync(
			"npx",
			[
				"--no-install",
				"esbuild",
				ENTRY,
				"--bundle",
				"--format=esm",
				"--platform=node",
				"--target=node20",
				`--outfile=${outfile}`,
				// sanitize-html es CJS y hace require() de builtins de node; en un bundle ESM eso
				// explota ("Dynamic require of \"path\" is not supported") salvo que inyectemos un
				// require real vía createRequire.
				'--banner:js=import { createRequire as __pandiCreateRequire } from "node:module"; const require = __pandiCreateRequire(import.meta.url);',
				"--log-level=warning",
			],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);
		if (result.status !== 0) {
			throw new Error(`esbuild failed:\n${result.stderr || result.stdout}`);
		}
		return `${BANNER}\n${readFileSync(outfile, "utf8")}`;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const check = process.argv.includes("--check");
	const bundle = buildBundle();
	if (check) {
		const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
		if (current !== bundle) {
			console.error(`[generate-claude-observe-core] ❌ drift: ${OUT} is out of date — rerun without --check`);
			process.exit(1);
		}
		console.log("[generate-claude-observe-core] ✅ up to date");
	} else {
		writeFileSync(OUT, bundle);
		console.log(`[generate-claude-observe-core] wrote ${OUT} (${bundle.length} bytes)`);
	}
}
