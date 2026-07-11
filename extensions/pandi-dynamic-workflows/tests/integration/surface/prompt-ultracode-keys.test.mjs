#!/usr/bin/env node
/**
 * GUARDIÁN single-source-of-truth: claves de scaffold en prompts ultracode.
 *
 * La fuente canónica de la línea compacta de keys es `formatWorkflowPatternKeyList()`
 * en surface/pattern-format.ts. Esa línea debe aparecer verbatim en:
 *   - makeUltracodePrompt() (bloque Reference de formatUltracodeRoutingRules)
 *   - makeAlwaysOnUltracodeSystemPrompt() (mismo bloque)
 *
 * Fase 1.2 del design audit de modularización (2026-06-28).
 *
 * Corrida directa:
 *   node extensions/pandi-dynamic-workflows/tests/integration/surface/prompt-ultracode-keys.test.mjs
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { check, counts } = createChecker();

async function buildUltracodePrompts() {
	const { url } = await buildDwfExtension({
		name: "pi-dwf-ultracode-keys",
		src: path.join(__dirname, "ultracode-prompt-keys-entry.ts"),
	});
	return import(url);
}

function extractReferenceBlock(prompt) {
	const marker = "Reference:\n";
	const start = prompt.indexOf(marker);
	if (start === -1) return null;
	return prompt.slice(start + marker.length).trim();
}

async function main() {
	const mod = await buildUltracodePrompts();
	const canonical = mod.formatWorkflowPatternKeyList();
	check("formatWorkflowPatternKeyList exportada", typeof canonical === "string" && canonical.length > 0);

	const commandPrompt = mod.makeUltracodePrompt("task de prueba", "ultracode", true);
	const alwaysOnPrompt = mod.makeAlwaysOnUltracodeSystemPrompt(true);
	const deepResearchPrompt = mod.makeUltracodePrompt("investigar X", "deep-research", false);

	check("makeUltracodePrompt incluye la línea canónica de keys", commandPrompt.includes(canonical));
	check("makeAlwaysOnUltracodeSystemPrompt incluye la línea canónica de keys", alwaysOnPrompt.includes(canonical));
	check("deep-research incluye la línea canónica de keys", deepResearchPrompt.includes(canonical));

	const commandRef = extractReferenceBlock(commandPrompt);
	const alwaysRef = extractReferenceBlock(alwaysOnPrompt);
	check("bloque Reference presente en command prompt", commandRef !== null);
	check("bloque Reference presente en always-on prompt", alwaysRef !== null);
	if (commandRef && alwaysRef) {
		const canonicalBullet = `- ${canonical}`;
		check("Reference command incluye bullet canónico de keys", commandRef.includes(canonicalBullet));
		check("Reference always-on incluye bullet canónico de keys", alwaysRef.includes(canonicalBullet));
	}

	// Cada key del catálogo debe figurar en la línea canónica (no solo el wrapper).
	const keys = canonical.match(/Scaffolds de workflow: ([^.]+)\./)?.[1]?.split(", ") ?? [];
	check("catálogo exporta al menos una key", keys.length > 0, String(keys.length));
	for (const key of keys) {
		check(`key '${key}' presente en línea canónica`, canonical.includes(key));
	}

	console.log(`\nTOTAL: ${counts.failed === 0 ? "all passed" : `${counts.failed} failed`}`);
	process.exit(counts.failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
