#!/usr/bin/env node
/**
 * Corre secuencialmente todas las suites de integración durables de paquetes Pi.
 *
 * Fuente de verdad = DISCOVERY por convención: se corre cada
 * `extensions/<ext>/tests/integration/*.test.mjs`. Cada extensión trae sus propias
 * suites, así que agregar una no exige editar nada acá — este runner solo orquesta y agrega.
 * Una suite que todavía no se espera que esté verde se excluye SOLO listándola explícitamente
 * en `ignoredDraftSuites` (con una razón); nunca se saltea nada en silencio.
 *
 * `npm test` delega acá después del typecheck. También podés correr la
 * suite de comportamiento directamente mientras iterás:
 *
 *   node scripts/test/run-all.mjs
 *   node scripts/test/run-all.mjs --list
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SUITE_TIMEOUT_MS = 120_000;
const SUITE_KILL_GRACE_MS = 5_000;
const EXTENSIONS_DIR = "extensions";
const SUITE_SUBDIR = path.posix.join("tests", "integration");
const ALLOWED_ARGS = new Set(["--list", "--serial"]);

// Las draft suites se excluyen, pero deben ser EXPLICIT (con una razón), para que una suite aún no verde
// nunca corra Y una suite verde nunca se saltee en silencio. Sacá una suite de acá cuando esté verde de forma confiable. Hoy está vacío.
const ignoredDraftSuites = new Set([]);

export function parseRunnerArgs(rawArgs) {
	const args = new Set(rawArgs);
	return { args, unknownArgs: rawArgs.filter((arg) => !ALLOWED_ARGS.has(arg)) };
}

export function computeConcurrency(args, env = process.env, cpuCount = os.cpus().length || 4) {
	// Las suites están aisladas por proceso (tempdir propio + child + import con cache-bust), así que corren en un
	// pool paralelo acotado para dar feedback rápido. El tope es conservador (default min(cpus,4)) para limitar la
	// contención de CPU que podría desestabilizar las pocas suites sensibles al timing; se puede overridear con TEST_CONCURRENCY o --serial.
	return args.has("--serial") ? 1 : Math.max(1, Number(env.TEST_CONCURRENCY) || Math.min(4, cpuCount || 4));
}

export function discoverSuites(repoRoot, ignoredSuites = ignoredDraftSuites) {
	// Descubre por convención los directorios de suites: los extensions/<ext>/tests/integration que existan.
	const extensionsDirAbs = path.join(repoRoot, EXTENSIONS_DIR);
	const suiteDirs = (fs.existsSync(extensionsDirAbs) ? fs.readdirSync(extensionsDirAbs, { withFileTypes: true }) : [])
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.posix.join(EXTENSIONS_DIR, entry.name, SUITE_SUBDIR))
		.filter((dir) => fs.existsSync(path.join(repoRoot, dir)))
		.sort();

	// Descubre las suites: cada *.test.mjs bajo esos directorios.
	const discoveredSuites = suiteDirs
		.flatMap((dir) =>
			fs
				.readdirSync(path.join(repoRoot, dir))
				.filter((name) => name.endsWith(".test.mjs"))
				.map((name) => path.posix.join(dir, name)),
		)
		.sort();

	return {
		suites: discoveredSuites.filter((suite) => !ignoredSuites.has(suite)),
		ignoredExisting: [...ignoredSuites].filter((suite) => fs.existsSync(path.join(repoRoot, suite))),
	};
}

export function suiteLabel(result) {
	return result.status === 0 ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
}

// Corre una suite en un child process, bufferizando su output (seguro en paralelo, a diferencia de `inherit` en vivo).
// Preserva la semántica de timeout+SIGTERM de la vieja ruta con spawnSync, con fallback a SIGKILL.
export function runSuite(
	suite,
	{
		repoRoot = REPO_ROOT,
		env = process.env,
		suiteTimeoutMs = SUITE_TIMEOUT_MS,
		suiteKillGraceMs = SUITE_KILL_GRACE_MS,
	} = {},
) {
	return new Promise((resolve) => {
		const started = Date.now();
		let out = "";
		let timedOut = false;
		let killTimer = null;
		const child = spawn(process.execPath, [path.join(repoRoot, suite)], { cwd: repoRoot, env });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), suiteKillGraceMs);
		}, suiteTimeoutMs);
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		const done = (status, signal, errText) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			resolve({ suite, status, elapsedMs: Date.now() - started, signal, timedOut, out: out + (errText || "") });
		};
		child.on("close", (code, signal) => done(typeof code === "number" ? code : 1, signal));
		child.on("error", (err) => done(1, null, `\n${err}`));
	});
}

async function runSuitePool(suites, concurrency, { run = runSuite, stdout = process.stdout } = {}) {
	// Worker pool acotado: como mucho CONCURRENCY suites en vuelo; los resultados se mantienen en orden de suite.
	const results = new Array(suites.length);
	let nextIndex = 0;
	async function worker() {
		while (nextIndex < suites.length) {
			const i = nextIndex++;
			const suite = suites[i];
			const result = await run(suite);
			results[i] = result;
			// Imprime el output bufferizado de cada suite como un bloque coherente cuando termina.
			stdout.write(`\n=== ${suite}: ${suiteLabel(result)} (${Math.round(result.elapsedMs / 1000)}s) ===\n`);
			if (result.out) stdout.write(result.out.endsWith("\n") ? result.out : `${result.out}\n`);
		}
	}

	stdout.write(`Running ${suites.length} suites, concurrency ${concurrency}...\n`);
	await Promise.all(Array.from({ length: Math.min(concurrency, suites.length) }, () => worker()));
	return results;
}

function printSummary(results, stdout = process.stdout) {
	const failed = results.filter((result) => result.status !== 0);
	stdout.write("\n=== integration summary ===\n");
	for (const result of results) {
		const suffix = result.signal ? ` signal=${result.signal}` : "";
		stdout.write(`${suiteLabel(result)} ${result.suite} (${Math.round(result.elapsedMs / 1000)}s)${suffix}\n`);
	}
	stdout.write(`${results.length - failed.length}/${results.length} suites passed\n`);
	return failed;
}

async function main(rawArgs = process.argv.slice(2)) {
	const { args, unknownArgs } = parseRunnerArgs(rawArgs);
	if (unknownArgs.length) {
		console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
		console.error("Usage: node scripts/test/run-all.mjs [--list] [--serial]");
		return 1;
	}

	const { suites, ignoredExisting } = discoverSuites(REPO_ROOT);
	if (args.has("--list")) {
		for (const suite of suites) console.log(suite);
		for (const suite of ignoredExisting) console.log(`# ignored draft: ${suite}`);
		return 0;
	}

	if (suites.length === 0) {
		console.error("No integration suites discovered under extensions/*/tests/integration");
		return 1;
	}

	const concurrency = computeConcurrency(args);
	const results = await runSuitePool(suites, concurrency);
	return printSummary(results).length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exit(await main());
}
