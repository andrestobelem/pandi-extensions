#!/usr/bin/env node
/**
 * Durable single-source parity test for the built-in agent personas.
 *
 * Source of truth = the `BUILTIN_AGENT_PERSONAS` object in agent-env-persona.ts. Every
 * persona key defined there MUST be surfaced 1:1 everywhere the persona menu is exposed,
 * or agents/users get an inconsistent list:
 *   - the runtime prompt string in index.ts (the agentType:'…' union)
 *   - the primitives/agent.md reference and its self-contained ultracode skill mirror
 *   - the README persona list
 *   - the ultracode skill: SKILL.md and its reference/personas.md catalog
 *
 * It also pins the read-only security invariant: every current built-in persona defaults
 * to READ_ONLY_AGENT_TOOLS. Adding a write-capable persona (e.g. an executor) must be a
 * CONSCIOUS change that updates this test — it should not slip in silently.
 *
 * No extension build / no model: pure filesystem + regex over source.
 *
 * Run it:
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

/** Parse BUILTIN_AGENT_PERSONAS into [{ name, body }] entries. */
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

	// Negative control: extraction must be non-vacuous and include known sentinels.
	check("persona extraction is non-vacuous", personas.length >= 5, `found=${personas.length}`);
	const names = personas.map((p) => p.name);
	check("extraction includes sentinel 'reviewer'", names.includes("reviewer"), names.join(","));
	check("extraction includes new 'architect'", names.includes("architect"), names.join(","));

	// Read every surface once.
	const surfaceText = Object.fromEntries(Object.entries(SURFACES).map(([label, p]) => [label, read(p)]));

	for (const { name, body } of personas) {
		// Read-only security invariant.
		check(
			`persona '${name}' defaults to READ_ONLY_AGENT_TOOLS`,
			/tools:\s*READ_ONLY_AGENT_TOOLS/.test(body),
			body.trim(),
		);
		// Present on every surface.
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
