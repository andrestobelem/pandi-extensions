// Test unitario que pinea el chequeo estricto de TypeScript para extensions/**/*.ts.
// Contrato: tsconfig.json debe fijar compilerOptions.strict === true, y
// correr `tsc -p tsconfig.json` bajo esa config debe salir con 0 (sin errores)
// en todos los sources de extensiones.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSCONFIG = path.join(REPO, "tsconfig.json");

test("tsconfig.json enables strict mode", () => {
	const config = JSON.parse(fs.readFileSync(TSCONFIG, "utf8"));
	assert.equal(config.compilerOptions.strict, true);
});

test("tsc -p tsconfig.json exits 0 (extensions/**/*.ts compiles clean under strict)", () => {
	const tsc = path.join(REPO, "node_modules", ".bin", "tsc");
	const result = spawnSync(tsc, ["-p", TSCONFIG], { cwd: REPO, encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
