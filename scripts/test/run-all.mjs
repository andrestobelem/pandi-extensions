#!/usr/bin/env node
/**
 * Corre secuencialmente todas las suites de integración durables de paquetes Pi.
 *
 * Fuente de verdad = DISCOVERY por convención: se corre cada
 * `extensions/<ext>/tests/integration/*.test.mjs` registrado en Git. Cada extensión trae sus propias
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

import { spawn, spawnSync } from "node:child_process";
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

function toPosixPath(file) {
	return file.replace(/\\/g, "/");
}

export function isIntegrationSuitePath(file) {
	const parts = toPosixPath(file).split("/");
	return (
		parts.length === 5 &&
		parts[0] === EXTENSIONS_DIR &&
		parts[1].length > 0 &&
		parts[2] === "tests" &&
		parts[3] === "integration" &&
		parts[4].endsWith(".test.mjs")
	);
}

export function isRunnerInfluencingPath(file) {
	const normalized = toPosixPath(file);
	return (
		normalized.startsWith(`${EXTENSIONS_DIR}/`) ||
		normalized.startsWith("scripts/test/") ||
		["package.json", "tsconfig.json", "biome.jsonc"].includes(normalized)
	);
}

function fileSetContainsPathOrAncestor(files, file) {
	if (!files) return false;
	const normalized = toPosixPath(file);
	if (files.has(normalized)) return true;
	const parts = normalized.split("/");
	for (let i = parts.length - 1; i > 0; i--) {
		if (files.has(`${parts.slice(0, i).join("/")}/`)) return true;
	}
	return false;
}

function gitFileSet(repoRoot, args) {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
	if (result.status !== 0) return undefined;
	return new Set(
		result.stdout
			.split(/\r?\n/)
			.map((line) => toPosixPath(line.trim()))
			.filter(Boolean),
	);
}

export function collectSuiteGitState(repoRoot) {
	const trackedFiles = gitFileSet(repoRoot, ["ls-files", "--cached"]);
	if (!trackedFiles) return undefined;
	return {
		trackedFiles,
		untrackedFiles: gitFileSet(repoRoot, ["ls-files", "--others", "--exclude-standard"]) ?? new Set(),
		ignoredFiles: gitFileSet(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard"]) ?? new Set(),
	};
}

function collectContaminatingFiles(gitState) {
	if (!gitState) return [];
	const contaminated = new Set();
	for (const files of [gitState.untrackedFiles, gitState.ignoredFiles]) {
		for (const file of files ?? []) {
			const normalized = toPosixPath(file);
			if (!isRunnerInfluencingPath(normalized)) continue;
			if (normalized.includes("/tests/integration/")) continue;
			contaminated.add(normalized);
		}
	}
	return [...contaminated].sort();
}

export function classifyDiscoveredSuites(discoveredSuites, ignoredSuites = ignoredDraftSuites, gitState) {
	const hasGitState = gitState?.trackedFiles instanceof Set;
	const suites = [];
	const unregisteredSuites = [];
	const ignoredSuiteFiles = [];

	for (const suite of discoveredSuites) {
		if (ignoredSuites.has(suite)) continue;
		if (!hasGitState || gitState.trackedFiles.has(suite)) {
			suites.push(suite);
		} else if (fileSetContainsPathOrAncestor(gitState.ignoredFiles, suite)) {
			ignoredSuiteFiles.push(suite);
		} else {
			unregisteredSuites.push(suite);
		}
	}

	return { suites, unregisteredSuites, ignoredSuiteFiles, contaminatingFiles: collectContaminatingFiles(gitState) };
}

export function hasSuiteContamination(discovery) {
	return (
		(discovery.unregisteredSuites?.length ?? 0) > 0 ||
		(discovery.ignoredSuiteFiles?.length ?? 0) > 0 ||
		(discovery.contaminatingFiles?.length ?? 0) > 0
	);
}

function formatSuiteList(title, suites) {
	if (!suites.length) return [];
	return [title, ...suites.map((suite) => `  - ${suite}`)];
}

export function formatSuiteContamination(discovery) {
	if (!hasSuiteContamination(discovery)) return "";
	return [
		"ENVIRONMENT CONTAMINATED: integration suites exist outside the tracked runner set.",
		"The integration runner aborts before executing registered suites so this is not reported as a test failure.",
		"Stage/commit intended new suites, remove unrelated concurrent-session files, or run a focused suite directly.",
		...formatSuiteList("Unregistered suites (untracked, skipped):", discovery.unregisteredSuites ?? []),
		...formatSuiteList("Ignored suites (gitignored, skipped):", discovery.ignoredSuiteFiles ?? []),
		...formatSuiteList("Other untracked/ignored runner-influencing files:", discovery.contaminatingFiles ?? []),
	].join("\n");
}

export function discoverSuites(
	repoRoot,
	ignoredSuites = ignoredDraftSuites,
	gitState = collectSuiteGitState(repoRoot),
) {
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
		...classifyDiscoveredSuites(discoveredSuites, ignoredSuites, gitState),
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

	const discovery = discoverSuites(REPO_ROOT);
	const { suites, ignoredExisting, unregisteredSuites, ignoredSuiteFiles, contaminatingFiles } = discovery;
	if (args.has("--list")) {
		for (const suite of suites) console.log(suite);
		for (const suite of ignoredExisting) console.log(`# ignored draft: ${suite}`);
		for (const suite of unregisteredSuites) console.log(`# unregistered suite (skipped): ${suite}`);
		for (const suite of ignoredSuiteFiles) console.log(`# ignored suite (skipped): ${suite}`);
		for (const file of contaminatingFiles) console.log(`# contaminated file (skipped): ${file}`);
		return 0;
	}

	if (hasSuiteContamination(discovery)) {
		console.error(formatSuiteContamination(discovery));
		return 1;
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
