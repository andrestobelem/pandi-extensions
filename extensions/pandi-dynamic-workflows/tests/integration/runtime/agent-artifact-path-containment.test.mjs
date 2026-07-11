/**
 * Test de regresión de seguridad: resolveAgentArtifactPath debe contener artifactPath
 * dentro de run.runDir.
 *
 * artifactPath nace de un events.jsonl no confiable (event-parser lo copia
 * verbatim al modelo del agente). Antes del fix, resolveAgentArtifactPath devolvía
 * paths absolutos tal cual y hacía path.join de relativos sin ningún check de contención, así un
 * path absoluto fabricado ("/etc/passwd") o un traversal "../" escapaba de runDir y llegaba a
 * fs.readFile en formatAgentView — una lectura arbitraria de archivos. Esto pinea la contención.
 *
 * Self-bootstrapping como las suites hermanas: esbuild de agent-view.ts directo (ahora
 * exporta resolveAgentArtifactPath) con SDK/tui/typebox aliased a stubs locales,
 * luego importa el named export. La función es pura (sin fs), así que no necesita fixtures.
 *
 * Corrélo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/agent-artifact-path-containment.test.mjs
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { check, counts } = createChecker();

async function buildExtension() {
	return await buildDwfModule({
		name: "pi-agent-artifact-path-integration",
		relPath: "tui/agent-view.ts",
		outName: "agent-view.mjs",
	});
}

function run(mod) {
	const { resolveAgentArtifactPath } = mod;
	const runDir = "/runs/abcd";
	const resolve = (artifactPath) => resolveAgentArtifactPath({ runDir }, { artifactPath });

	check(
		"resolveAgentArtifactPath is exported",
		typeof resolveAgentArtifactPath === "function",
		typeof resolveAgentArtifactPath,
	);

	// Legítimo: un artifact relativo dentro de runDir resuelve bajo runDir.
	check(
		"keeps a relative artifact inside runDir",
		resolve("agents/0001-alpha.md") === path.resolve(runDir, "agents/0001-alpha.md"),
		String(resolve("agents/0001-alpha.md")),
	);

	// artifactPath ausente -> undefined.
	check("undefined when no artifactPath", resolve(undefined) === undefined, String(resolve(undefined)));

	// Ataque 1: un path absoluto que escapa de runDir se rechaza.
	check(
		"rejects an absolute path outside runDir",
		resolve("/etc/passwd") === undefined,
		String(resolve("/etc/passwd")),
	);

	// Ataque 2: un traversal "../" que escapa de runDir se rechaza.
	check(
		"rejects a ../ traversal escaping runDir",
		resolve("../../etc/passwd") === undefined,
		String(resolve("../../etc/passwd")),
	);

	// Borde: un traversal que resuelve de vuelta dentro de runDir sigue permitido.
	check(
		"allows a ../ traversal that stays inside runDir",
		resolve("agents/../answer.md") === path.resolve(runDir, "answer.md"),
		String(resolve("agents/../answer.md")),
	);
}

async function main() {
	const { url } = await buildExtension();
	const mod = await import(`${url}?i=0`);

	run(mod);

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
