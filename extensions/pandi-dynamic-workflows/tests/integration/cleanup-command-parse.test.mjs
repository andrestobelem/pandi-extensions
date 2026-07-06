#!/usr/bin/env node
/**
 * Test de contrato para el parser de argumentos de `/workflow cleanup` (command-handlers.ts,
 * parseCleanupArgs).
 *
 * El comando cleanup mezcla un token target opcional (sessions | runs | both) con flags
 * (--keep=N, --all-stale, --dry-run/-n, --yes/-y). Esto pinea el parseo para que el comando
 * destructivo no pueda cambiar silenciosamente sus defaults: cleanup apunta a BOTH por default,
 * retiene DEFAULT_CLEANUP_KEEP (20) runs, NO toca sesiones heartbeat-stale, y no hace
 * dry-run ni auto-confirma salvo que se pida.
 *
 * Puro + offline: bundlea command-handlers.ts con los stubs estándar y llama el
 * parser exportado en memoria.
 *
 * Corrélo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/cleanup-command-parse.test.mjs
 */
import * as path from "node:path";
import { buildExtension, createChecker, REPO_ROOT, sdkStub } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

async function loadModule() {
	const { url } = await buildExtension({
		name: "pi-dwf-cleanup-command-parse",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "command-handlers.ts"),
		outName: "command-handlers.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	return await import(url);
}

async function main() {
	const { parseCleanupArgs, DEFAULT_CLEANUP_KEEP } = await loadModule();
	check("exports parseCleanupArgs", typeof parseCleanupArgs === "function", typeof parseCleanupArgs);
	check("exports DEFAULT_CLEANUP_KEEP=20", DEFAULT_CLEANUP_KEEP === 20, String(DEFAULT_CLEANUP_KEEP));

	// 1) Args vacíos → defaults seguros: ambos targets, keep=20, sin stale, sin dry-run, sin yes.
	{
		const p = parseCleanupArgs("");
		check(
			"empty → both/keep20/defaults",
			p.target === "both" &&
				p.keep === 20 &&
				p.includeHeartbeatStale === false &&
				p.dryRun === false &&
				p.yes === false,
			JSON.stringify(p),
		);
	}

	// 2) El token target se reconoce y normaliza.
	check("sessions", parseCleanupArgs("sessions").target === "sessions");
	check("session→sessions", parseCleanupArgs("session").target === "sessions");
	check("runs", parseCleanupArgs("runs").target === "runs");
	check("run→runs", parseCleanupArgs("run").target === "runs");
	check("both explicit", parseCleanupArgs("both").target === "both");
	check("unknown token → both", parseCleanupArgs("garbage").target === "both");

	// 3) --keep=N sobrescribe el default; clamp a entero >= 0.
	check("--keep=5", parseCleanupArgs("runs --keep=5").keep === 5);
	check("--keep=0", parseCleanupArgs("runs --keep=0").keep === 0);
	check("--keep negative clamps to 0", parseCleanupArgs("runs --keep=-3").keep === 0);
	check("--keep non-numeric → default", parseCleanupArgs("runs --keep=abc").keep === 20);

	// 4) Flags booleanas en cualquier orden, con/sin target.
	{
		const p = parseCleanupArgs("sessions --all-stale --dry-run -y");
		check(
			"all-stale + dry-run + yes",
			p.target === "sessions" && p.includeHeartbeatStale === true && p.dryRun === true && p.yes === true,
			JSON.stringify(p),
		);
	}
	check("-n is dry-run alias", parseCleanupArgs("-n").dryRun === true);
	check("--yes long form", parseCleanupArgs("--yes").yes === true);
	check("flags without target keep both", parseCleanupArgs("--dry-run").target === "both");

	// 5) Independencia de orden: flag antes de target.
	{
		const p = parseCleanupArgs("--keep=3 runs");
		check("flag-before-target", p.target === "runs" && p.keep === 3, JSON.stringify(p));
	}

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
