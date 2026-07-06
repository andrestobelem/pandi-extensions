#!/usr/bin/env node
/**
 * Test durable de paridad single-source para las personas de agente built-in.
 *
 * Fuente de verdad = el objeto `BUILTIN_AGENT_PERSONAS` en agent-env-persona.ts. Cada key
 * de persona definida ahí DEBE exponerse 1:1 en todas las superficies donde aparece el menú
 * de personas, o agentes/personas usuarias reciben una lista inconsistente:
 *   - el string de prompt runtime en index.ts (la unión agentType:'…')
 *   - la referencia primitives/agent.md y su mirror autocontenido del skill ultracode
 *   - la lista de personas del README
 *   - el skill ultracode: SKILL.md y su catálogo reference/personas.md
 *
 * También fija el invariante de seguridad read-only: cada persona built-in actual defaulta
 * a READ_ONLY_AGENT_TOOLS. Agregar una persona con capacidad de escritura (p. ej. un executor)
 * debe ser un cambio CONSCIENTE que actualice este test; no debería colarse en silencio.
 *
 * Sin build de extensión / sin modelo: filesystem puro + regex sobre la fuente.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/persona-catalog-parity.test.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXT_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows");
const SKILL_DIR = path.join(REPO_ROOT, ".pi", "skills", "ultracode");

const PERSONA_SRC = path.join(EXT_DIR, "agent-env-persona.ts");
const SURFACES = {
	"index.ts prompt": path.join(EXT_DIR, "index.ts"),
	"primitives/agent.md": path.join(EXT_DIR, "primitives", "agent.md"),
	"skill mirror agent.md": path.join(SKILL_DIR, "reference", "primitives", "agent.md"),
	README: path.join(REPO_ROOT, "README.md"),
	"skill SKILL.md": path.join(SKILL_DIR, "SKILL.md"),
	"skill reference/personas.md": path.join(SKILL_DIR, "reference", "personas.md"),
};

const { check, counts } = createChecker();
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

/** Parsea BUILTIN_AGENT_PERSONAS en entries [{ name, body }]. */
function parsePersonas(source) {
	const block = source.match(/BUILTIN_AGENT_PERSONAS[^{]*{([\s\S]*?)\n};/);
	if (!block) return [];
	const out = [];
	for (const m of block[1].matchAll(/\n\t([a-z][a-zA-Z0-9]*):\s*{([\s\S]*?)\n\t},/g)) {
		out.push({ name: m[1], body: m[2] });
	}
	return out;
}

function main() {
	const personaSrc = read(PERSONA_SRC);
	const personas = parsePersonas(personaSrc);

	// Control negativo: la extracción debe ser no vacua e incluir sentinels conocidos.
	check("persona extraction is non-vacuous", personas.length >= 5, `found=${personas.length}`);
	const names = personas.map((p) => p.name);
	check("extraction includes sentinel 'reviewer'", names.includes("reviewer"), names.join(","));
	check("extraction includes new 'architect'", names.includes("architect"), names.join(","));

	// Leé cada superficie una sola vez.
	const surfaceText = Object.fromEntries(Object.entries(SURFACES).map(([label, p]) => [label, read(p)]));

	for (const { name, body } of personas) {
		// Invariante de seguridad read-only.
		check(
			`persona '${name}' defaults to READ_ONLY_AGENT_TOOLS`,
			/tools:\s*READ_ONLY_AGENT_TOOLS/.test(body),
			body.trim(),
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

main();
