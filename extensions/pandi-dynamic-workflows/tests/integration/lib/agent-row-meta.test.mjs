#!/usr/bin/env node
/**
 * Contrato de chips de meta por fila de agente compartidos entre TUI y HTML.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { check, counts } = createChecker();

async function main() {
	const { url } = await buildDwfModule({
		name: "pi-dwf-agent-row-meta-lib",
		relPath: "lib/agent-row-meta.ts",
		outName: "agent-row-meta.mjs",
		stubs: { sdk: (dir) => dir && "" },
	});
	const { buildAgentRowMetaChips, agentRowMetaChipTone } = await loadModule(url);

	const chips = buildAgentRowMetaChips({
		promptAvailable: true,
		schemaOk: true,
		tools: ["read", "grep"],
		skills: ["karpathy"],
		extensions: ["pandi-loop"],
		includeExtensions: false,
		keys: ["OPENAI_API_KEY"],
		missingKeys: ["ANTHROPIC_API_KEY"],
	});

	check(
		"buildAgentRowMetaChips emits the compact monitor vocabulary",
		chips.join(" · ") === "prompt✓ · schema:ok · tools:2 · skills:1 · ext:1 · keys:1 · missing:1",
		chips.join(" · "),
	);
	check(
		"buildAgentRowMetaChips accepts comma-separated HTML fields",
		buildAgentRowMetaChips({
			promptAvailable: false,
			schemaOk: false,
			tools: "read, grep",
			outputEmpty: true,
			model: "anthropic/claude-sonnet-4",
			thinking: "high",
		}).includes("model:claude-sonnet-4"),
		"",
	);
	check("agentRowMetaChipTone classifies integrity chips", agentRowMetaChipTone("schema:bad") === "fail");
	check("agentRowMetaChipTone classifies truncated chips", agentRowMetaChipTone("output:truncated") === "warn");

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
