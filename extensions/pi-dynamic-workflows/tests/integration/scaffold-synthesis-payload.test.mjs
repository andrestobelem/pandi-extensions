/**
 * Behavior: fan-out -> synthesis scaffolds must NOT feed raw ctx.agents() result
 * objects into ctx.compact(). Each AgentResult carries heavy fields (prompt,
 * stdout, stderr, tools, extensions, ...) far larger than its `.output` text, so
 * compacting the raw array burns the char budget on metadata and silently
 * truncates later branches' actual content before the synthesis judge reads it
 * (observed in a real run: reviews.json was 409 KB while the two outputs were
 * ~10 KB combined, and the judge reported "only branch 1's output survived").
 *
 * Contract: the synthesis step must compact a PROJECTION that includes each
 * branch's `output` (and ideally its `name`), not the bare `completed*` array.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension as sharedBuildExtension, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-scaffold-payload",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "full" }),
		},
		npx: "--yes",
	});
}

function makeCtx() {
	return {
		mode: "tui",
		hasUI: true,
		cwd: REPO_ROOT,
		isProjectTrusted: () => true,
		ui: { theme: { fg: (_c, v) => v } },
	};
}

let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
	if (!ok) {
		failures++;
		if (detail) console.log("   -> " + String(detail).slice(0, 300));
	}
}

// scaffold key -> the raw filtered-results identifier it currently compacts.
const FAN_OUT_SYNTHESIS = {
	"fan-out-and-synthesize": "completedReviews",
	"complex-research": "completedResearch",
	"bug-hunt-repo-audit": "completedReviews",
	"plan-review": "completedCritiques",
};

const { url } = await buildExtension();
const mod = await import(url);
const ext = mod.default;

const tools = new Map();
const pi = {
	events: { on: () => {} },
	on: () => {},
	registerTool: (d) => tools.set(d.name, d),
	registerCommand: () => {},
	registerShortcut: () => {},
	appendEntry: () => {},
	sendUserMessage: () => {},
	getThinkingLevel: () => "medium",
	setThinkingLevel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [...tools.values()],
	setActiveTools: () => {},
	exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
};
const activate = ext.activate ?? ext;
await activate(pi, makeCtx());
const tool = tools.get("dynamic_workflow");
if (!tool) throw new Error("dynamic_workflow tool not registered");

const signal = new AbortController().signal;
const ctx = makeCtx();

for (const [key, rawVar] of Object.entries(FAN_OUT_SYNTHESIS)) {
	const res = await tool.execute(
		"scaffold",
		{ action: "template", name: key },
		signal,
		() => {},
		ctx,
	);
	const code = res?.content?.[0]?.text ?? "";

	// 1) Must NOT compact the bare raw-results array (metadata footgun).
	const rawCompact = new RegExp(`ctx\\.compact\\(\\s*${rawVar}\\s*,`);
	check(
		`${key}: does not compact raw ${rawVar} array`,
		!rawCompact.test(code),
		code.match(rawCompact)?.[0],
	);

	// 2) Must project to textual output before compacting (attribution-friendly).
	const projects = /\.map\(\s*\(?\s*r\s*\)?\s*=>\s*\(\{[^}]*\boutput:\s*r\.output\b/.test(code);
	check(
		`${key}: projects results to {..., output: r.output} for synthesis`,
		projects,
		code.slice(0, 0),
	);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAIL"}`);
process.exit(failures === 0 ? 0 : 1);
