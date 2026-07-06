#!/usr/bin/env node
/**
 * Test durable de paridad single-source para las personas de agente built-in.
 *
 * Fuente de verdad = el objeto `BUILTIN_AGENT_PERSONAS` en agent-env-persona.ts. Cada key
 * de persona definida ahí DEBE exponerse 1:1 en todas las superficies donde aparece el menú
 * de personas, o agentes/personas usuarias reciben una lista inconsistente:
 *   - el string de prompt runtime en workflow-tool-contract.ts (la unión agentType:'…')
 *   - la referencia primitives/agent.md y su mirror autocontenido del skill ultracode
 *   - la lista de personas del README
 *   - el skill ultracode: SKILL.md y su catálogo reference/personas.md
 *
 * También fija el invariante de seguridad read-only: cada persona built-in actual defaulta
 * a READ_ONLY_AGENT_TOOLS. Agregar una persona con capacidad de escritura (p. ej. un executor)
 * debe ser un cambio CONSCIENTE que actualice este test; no debería colarse en silencio.
 *
 * Sin modelo: bundlea el módulo persona para leer la export real, y compara surfaces de filesystem.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/persona-catalog-parity.test.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXT_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows");
const SKILL_DIR = path.join(REPO_ROOT, ".pi", "skills", "ultracode");

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const SURFACES = {
	"workflow tool prompt": path.join(EXT_DIR, "workflow-tool-contract.ts"),
	"primitives/agent.md": path.join(EXT_DIR, "primitives", "agent.md"),
	"skill mirror agent.md": path.join(SKILL_DIR, "reference", "primitives", "agent.md"),
	README: path.join(REPO_ROOT, "README.md"),
	"skill SKILL.md": path.join(SKILL_DIR, "SKILL.md"),
	"skill reference/personas.md": path.join(SKILL_DIR, "reference", "personas.md"),
};

const { check, counts } = createChecker();
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

async function loadBuiltInPersonas() {
	const { url } = await sharedBuildExtension({
		name: "pi-dw-persona-catalog-parity",
		src: path.join(EXT_DIR, "agent-env-persona.ts"),
		outName: "agent-env-persona.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
	const mod = await import(url);
	return Object.entries(mod.BUILTIN_AGENT_PERSONAS ?? {}).map(([name, options]) => ({ name, options }));
}

async function main() {
	const personas = await loadBuiltInPersonas();

	// Control negativo: la extracción debe ser no vacua e incluir sentinels conocidos.
	check("persona extraction is non-vacuous", personas.length >= 5, `found=${personas.length}`);
	const names = personas.map((p) => p.name);
	check("extraction includes sentinel 'reviewer'", names.includes("reviewer"), names.join(","));
	check("extraction includes new 'architect'", names.includes("architect"), names.join(","));

	// Leé cada superficie una sola vez.
	const surfaceText = Object.fromEntries(Object.entries(SURFACES).map(([label, p]) => [label, read(p)]));

	for (const { name, options } of personas) {
		// Invariante de seguridad read-only.
		check(
			`persona '${name}' defaults to the read-only tool set`,
			Array.isArray(options?.tools) && options.tools.join(",") === READ_ONLY_TOOLS.join(","),
			`tools=${JSON.stringify(options?.tools)}`,
		);
		// Presente en cada superficie.
		for (const [label, text] of Object.entries(surfaceText)) {
			check(`persona '${name}' is surfaced in ${label}`, text.includes(name), label);
		}
	}

	finish();
}

function finish() {
	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log(`Failures:\n  - ${counts.failures.join("\n  - ")}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
