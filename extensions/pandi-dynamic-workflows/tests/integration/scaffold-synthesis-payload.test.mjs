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
import { sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-scaffold-payload",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		copyDirs: { scaffolds: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds") },
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "full" }),
		},
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
		if (detail) console.log(`   -> ${String(detail).slice(0, 300)}`);
	}
}

// scaffold key -> the raw filtered-results identifier it must NOT compact bare.
const FAN_OUT_SYNTHESIS = {
	"fan-out-and-synthesize": "completedReviews",
	"complex-research": "completedResearch",
	"repo-bug-hunt": "completedReviews",
	"adversarial-plan-review": "completedCritiques",
};

// Patterns that ALSO compact an evidence block in a synthesis-as-judge step but do NOT use
// the {name, output} fan-out projection (they compact rounds/verification arrays). Only the
// position-aware restatement (check #3) applies to them — not checks #1/#2.
// ("tournament" is intentionally excluded: its scaffold is an elimination bracket that
// returns the champion's text directly, with no synthesis compact() step to anchor.)
const POSITION_AWARE_EXTRA = ["loop-until-dry", "composition-driver"];

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
	const res = await tool.execute("scaffold", { action: "scaffold", name: key }, signal, () => {}, ctx);
	const code = res?.content?.[0]?.text ?? "";

	// 1) Must NOT compact the bare raw-results array (metadata footgun).
	const rawCompact = new RegExp(`\\bcompact\\(\\s*${rawVar}\\s*,`);
	check(`${key}: does not compact raw ${rawVar} array`, !rawCompact.test(code), code.match(rawCompact)?.[0]);

	// 2) Must project to textual output before compacting (attribution-friendly).
	const projects = /\.map\(\s*\(?\s*r\s*\)?\s*=>\s*\(\{[^}]*\boutput:\s*r\.output\b/.test(code);
	check(`${key}: projects results to {..., output: r.output} for synthesis`, projects, code.slice(0, 0));

	// 3) Position-aware (lost-in-the-middle): the task must be restated AFTER the
	//    evidence block, so instructions sit at BOTH ends of the synthesis prompt
	//    rather than only at the top where a long evidence block can bury them.
	const compactIdx = code.lastIndexOf("compact(");
	const tail = compactIdx >= 0 ? code.slice(compactIdx) : "";
	const restated = /Ahora (producí|hacé exactamente|escribí|sintetizá)/.test(tail);
	check(`${key}: restates the task AFTER the evidence (both-ends framing)`, restated, tail.slice(0, 140));
}

// Position-aware restatement (check #3 only) for the non-fan-out synthesis patterns, so a
// regression that drops a footer from these scaffolds is also caught.
for (const key of POSITION_AWARE_EXTRA) {
	const res = await tool.execute("scaffold", { action: "scaffold", name: key }, signal, () => {}, ctx);
	const code = res?.content?.[0]?.text ?? "";
	const compactIdx = code.lastIndexOf("compact(");
	const tail = compactIdx >= 0 ? code.slice(compactIdx) : "";
	const restated = /Ahora (producí|hacé exactamente|escribí|sintetizá)/.test(tail);
	check(`${key}: restates the task AFTER the evidence (both-ends framing)`, restated, tail.slice(0, 140));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
