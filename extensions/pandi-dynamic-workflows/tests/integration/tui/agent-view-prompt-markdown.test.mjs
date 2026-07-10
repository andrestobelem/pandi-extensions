#!/usr/bin/env node
/**
 * Issue #51: the dashboard agent Prompt tab must render the prompt as Markdown,
 * not as one giant fenced text block. The source should prefer the event-level
 * promptCopy when present, so headings inside the prompt (e.g. "## Structured
 * Output") are not mistaken for artifact section delimiters and lost.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildAgentView() {
	const { url } = await buildExtension({
		name: "pi-dwf-agent-prompt-markdown",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "tui/agent-view.ts"),
		outName: "agent-view.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	return await loadModule(url);
}

function makeRun(runDir) {
	return {
		runId: "run-prompt-md",
		workflow: "wf",
		runDir,
		agentCount: 1,
		background: true,
		scope: "project",
		state: "completed",
		ok: true,
	};
}

async function writeAgentArtifact(runDir, body) {
	await fs.mkdir(path.join(runDir, "agents"), { recursive: true });
	await fs.writeFile(path.join(runDir, "agents", "0001-alpha.md"), body, "utf8");
}

async function main() {
	const mod = await buildAgentView();
	const { buildAgentViewParts } = mod;
	check("buildAgentViewParts is exported for prompt-view smoke tests", typeof buildAgentViewParts === "function");
	if (typeof buildAgentViewParts !== "function") {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}

	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-prompt-md-"));
	try {
		const runDir = path.join(tmp, "run");
		const run = makeRun(runDir);
		const promptCopy = [
			"# Task",
			"",
			"- keep this list item",
			"",
			"## Structured Output",
			"",
			"This heading belongs to the prompt, not to the artifact metadata.",
			"",
			"```ts",
			"const bamboo = true;",
			"```",
		].join("\n");
		await writeAgentArtifact(
			runDir,
			[
				"# alpha",
				"",
				"## Access",
				"",
				"read-only",
				"",
				"## Prompt",
				"",
				"ARTIFACT-PROMPT-SHOULD-NOT-WIN",
				"",
				"## Structured Output",
				"",
				"artifact metadata",
				"",
				"## Stdout",
				"",
				"{}",
			].join("\n"),
		);

		const withCopy = await buildAgentViewParts(run, {
			id: 1,
			name: "alpha",
			state: "completed",
			artifactPath: "agents/0001-alpha.md",
			promptAvailable: true,
			promptCopy,
			promptTruncated: false,
		});
		check("prompt tab renders a card title", withCopy.prompt.includes("# Prompt: Agent #1: alpha"), withCopy.prompt);
		check("prompt tab renders summary metadata", withCopy.prompt.includes("## Summary"), withCopy.prompt);
		check(
			"prompt tab records event promptCopy as the source",
			/\| Source \| event promptCopy \|/.test(withCopy.prompt),
			withCopy.prompt,
		);
		check(
			"prompt tab separates metadata from the prompt body",
			withCopy.prompt.includes("## Prompt body") &&
				withCopy.prompt.indexOf("## Prompt body") < withCopy.prompt.indexOf("# Task"),
			withCopy.prompt,
		);
		check("prompt body includes the source heading", withCopy.prompt.includes("# Task"), withCopy.prompt);
		check(
			"prompt body includes source list items",
			withCopy.prompt.includes("- keep this list item"),
			withCopy.prompt,
		);
		check(
			"prompt tab preserves headings that look like artifact delimiters",
			withCopy.prompt.includes("## Structured Output") &&
				withCopy.prompt.includes("This heading belongs to the prompt"),
			withCopy.prompt,
		);
		check(
			"prompt tab preserves code fences",
			withCopy.prompt.includes("```ts\nconst bamboo = true;\n```"),
			withCopy.prompt,
		);
		check(
			"promptCopy wins over parser-truncatable artifact text",
			!withCopy.prompt.includes("ARTIFACT-PROMPT-SHOULD-NOT-WIN"),
			withCopy.prompt,
		);
		check(
			"prompt Markdown is not wrapped in one global text fence",
			!/```text\n# Task/.test(withCopy.prompt),
			withCopy.prompt,
		);

		const fallbackRunDir = path.join(tmp, "fallback-run");
		const fallbackRun = makeRun(fallbackRunDir);
		await writeAgentArtifact(
			fallbackRunDir,
			[
				"# beta",
				"",
				"## Access",
				"",
				"read-only",
				"",
				"## Prompt",
				"",
				"# Fallback Prompt",
				"",
				"- from artifact",
				"",
				"## Stdout",
				"",
				"{}",
			].join("\n"),
		);
		const fallback = await buildAgentViewParts(fallbackRun, {
			id: 1,
			name: "beta",
			state: "completed",
			artifactPath: "agents/0001-alpha.md",
			promptAvailable: true,
		});
		check(
			"artifact fallback records the artifact Prompt section as source",
			/\| Source \| artifact Prompt section \|/.test(fallback.prompt),
			fallback.prompt,
		);
		check("artifact fallback keeps prompt Markdown", fallback.prompt.includes("# Fallback Prompt"), fallback.prompt);
		check(
			"artifact fallback is not globally fenced",
			!/```text\n# Fallback Prompt/.test(fallback.prompt),
			fallback.prompt,
		);
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
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
