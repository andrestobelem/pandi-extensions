#!/usr/bin/env node
/**
 * Guard de prosa Pandi para templates de dynamic workflows.
 *
 * Los scaffolds y catálogos son prompts/templates que leen humanos y subagentes. Su prosa debe estar
 * en español técnico, preservando en inglés únicamente tokens técnicos (keys JSON, enums, comandos,
 * rutas, nombres de tools/modelos/providers y sentinels parseables como NO_FINDINGS).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createChecker, REPO_ROOT } from "../../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

const CANONICAL_FILES = [
	...fs
		.readdirSync(path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds"))
		.filter((file) => file.endsWith(".js"))
		.map((file) => path.join("extensions", "pandi-dynamic-workflows", "scaffolds", file)),
	path.join("extensions", "pandi-dynamic-workflows", "surface", "catalog.ts"),
	path.join("extensions", "pandi-dynamic-workflows", "surface", "pattern-format.ts"),
];

const BANNED_PROSE = [
	{ re: /\bYou are\b/, why: "rol de prompt en inglés" },
	{ re: /\bYour job\b/, why: "instrucción de prompt en inglés" },
	{ re: /\bEverything inside\b/, why: "regla de fence en inglés" },
	{ re: /\bTreat everything\b/, why: "regla de datos no confiables en inglés" },
	{ re: /\bDo not\b/, why: "prohibición en inglés" },
	{ re: /\bReturn (only|ONLY|JSON|Markdown|a |the |the requested|one )/, why: "contrato de salida en inglés" },
	{ re: /\bOutput (ONLY|Markdown|HTML|artifacts|:)\b/, why: "contrato de output en inglés" },
	{ re: /^\s*`?Task:/, why: "label de tarea en inglés" },
	{ re: /^\s*`?## Verdict\b/, why: "heading Markdown en inglés" },
	{ re: /^\s*`?## Findings\b/, why: "heading Markdown en inglés" },
	{ re: /Workflow pattern catalog/, why: "catálogo visible en inglés" },
	{ re: /Use in TUI:/, why: "instrucción de catálogo en inglés" },
	{ re: /Use from command line:/, why: "instrucción de catálogo en inglés" },
	{ re: /Use from tool:/, why: "instrucción de catálogo en inglés" },
	{ re: /^\s*`?\s*When:/, why: "label de catálogo en inglés" },
	{ re: /^\s*`?\s*Use cases:/, why: "label de catálogo en inglés" },
	{ re: /Workflow composition rules:/, why: "guía de composición en inglés" },
	{ re: /Composition: use workflow/, why: "resumen de composición en inglés" },
	{ re: /Turn a vague ask/, why: "blurb de catálogo en inglés" },
	{ re: /Cheap input\/output/, why: "blurb de catálogo en inglés" },
	{ re: /Classify a request/, why: "blurb de catálogo en inglés" },
	{ re: /A planner decomposes/, why: "blurb de catálogo en inglés" },
	{ re: /Parent workflow/, why: "blurb de catálogo en inglés" },
	{ re: /Reusable sub-workflow/, why: "blurb de catálogo en inglés" },
	{ re: /No existing workflow fits/, why: "useWhen de catálogo en inglés" },
	{ re: /Reference \(pi/, why: "blurb de catálogo en inglés" },
	{ re: /Scatter-gather/, why: "blurb de catálogo en inglés" },
	{ re: /Scout then/, why: "blurb de catálogo en inglés" },
	{ re: /Scout code files/, why: "blurb de catálogo en inglés" },
	{ re: /Keep fanning/, why: "blurb de catálogo en inglés" },
	{ re: /Independent research/, why: "blurb de catálogo en inglés" },
	{ re: /Per-finding skeptic/, why: "blurb de catálogo en inglés" },
	{ re: /Confirm suspected/, why: "blurb de catálogo en inglés" },
	{ re: /N fixed-angle/, why: "blurb de catálogo en inglés" },
	{ re: /Generate candidates/, why: "blurb de catálogo en inglés" },
	{ re: /Single-elimination/, why: "blurb de catálogo en inglés" },
	{ re: /Sample N/, why: "blurb de catálogo en inglés" },
	{ re: /Beam search/, why: "blurb de catálogo en inglés" },
	{ re: /Bounded in-place/, why: "blurb de catálogo en inglés" },
	{ re: /Verbal-RL/, why: "blurb de catálogo en inglés" },
	{ re: /A real applier/, why: "blurb de catálogo en inglés" },
	{ re: /Hierarchical map-reduce/, why: "blurb de catálogo en inglés" },
];

for (const rel of CANONICAL_FILES.sort()) {
	const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
	const findings = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const { re, why } of BANNED_PROSE) {
			if (re.test(line)) findings.push(`${rel}:${i + 1}: ${why}: ${line.trim().slice(0, 180)}`);
		}
	}
	check(`${rel}: prosa contractual visible en español`, findings.length === 0, findings.join("\n"));
}

console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
if (counts.failed) {
	console.log(counts.failures.map((failure) => `- ${failure}`).join("\n"));
	process.exit(1);
}
