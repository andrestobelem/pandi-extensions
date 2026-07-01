#!/usr/bin/env node
/**
 * Durable parity test for the `architect` built-in persona.
 *
 * `architect` is the read-only solution-design persona (distinct from `planner`,
 * which owns decomposition/routing) — added to close the gap vs. the recurring
 * multi-agent role taxonomy (MetaGPT Architect/PM, etc.). It must default to
 * read-only tools + high reasoning, and it must be enumerated 1:1 across EVERY
 * place the persona list is surfaced, or agents/users get an inconsistent menu:
 *   - the canonical definition in agent-env-persona.ts (BUILTIN_AGENT_PERSONAS)
 *   - the runtime prompt string in index.ts
 *   - the primitives/agent.md reference and its self-contained skill mirror
 *   - the README persona list
 *
 * No extension build / no model: pure filesystem + regex over source.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/persona-architect-parity.test.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXT_DIR = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows");

const PERSONA_SRC = path.join(EXT_DIR, "agent-env-persona.ts");
const INDEX_SRC = path.join(EXT_DIR, "index.ts");
const AGENT_MD = path.join(EXT_DIR, "primitives", "agent.md");
const AGENT_MD_MIRROR = path.join(REPO_ROOT, ".pi", "skills", "ultracode", "reference", "primitives", "agent.md");
const README = path.join(REPO_ROOT, "README.md");

const { check, counts } = createChecker();

const read = (p) => fs.readFileSync(p, "utf8");

function main() {
	const persona = read(PERSONA_SRC);

	// 1. Canonical definition: architect entry inside BUILTIN_AGENT_PERSONAS.
	const block = persona.match(/BUILTIN_AGENT_PERSONAS[^{]*{([\s\S]*?)\n};/);
	check("BUILTIN_AGENT_PERSONAS block found", Boolean(block), "regex miss");
	const body = block ? block[1] : "";

	// The architect entry: read-only tools + high reasoning + a design-focused prompt.
	const entry = body.match(/architect:\s*{([\s\S]*?)\n\t},/);
	check("architect persona is defined", Boolean(entry), "no `architect:` key in BUILTIN_AGENT_PERSONAS");
	const arch = entry ? entry[1] : "";
	check("architect uses READ_ONLY_AGENT_TOOLS", /tools:\s*READ_ONLY_AGENT_TOOLS/.test(arch), arch.trim());
	check("architect reasons at high effort", /thinking:\s*"high"/.test(arch), arch.trim());
	check("architect prompt is design/architecture-focused", /architect|design/i.test(arch), arch.trim());

	// 2. Runtime prompt string in index.ts enumerates architect.
	const index = read(INDEX_SRC);
	check(
		"index.ts persona union lists architect",
		/agentType[^\n]*architect/.test(index),
		"not in agentType:'…' union",
	);

	// 3. Reference doc + self-contained skill mirror enumerate architect.
	check("primitives/agent.md lists architect", /architect/.test(read(AGENT_MD)), AGENT_MD);
	check("skill mirror agent.md lists architect", /architect/.test(read(AGENT_MD_MIRROR)), AGENT_MD_MIRROR);

	// 4. README persona list enumerates architect.
	check("README persona list mentions architect", /architect/.test(read(README)), README);

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
