// TEMP repo-audit-4 (delete after): anthropic-only close-out of the 3 areas still uncovered
// after runs 1-3. Codex JSON-output shards returned "empty JSON event stream" persistently, so
// this run uses ONLY anthropic (opus/sonnet), which was reliable. core-dispatch-b is dual-reviewed
// (opus + sonnet) since it is the untested half of the core dispatcher. Retry-on-empty with
// cache:false, verbosity cap, lenient JSON-block parse, generous maxAgents (>= 2*shards + 1).

export const meta = {
	name: "repo-audit-4",
	description: "Anthropic-only close-out of the 3 uncovered areas.",
	phases: [{ title: "fan-out review" }, { title: "synthesis" }],
};

const READ_ONLY = ["read", "grep", "find", "ls"];

const TIER = {
	opusHigh: { model: "anthropic/claude-opus-4-8", effort: "high" },
	sonnetHigh: { model: "anthropic/claude-sonnet-4-6", effort: "high" },
};

const PREFIX = [
	"You are a meticulous, ADVERSARIAL code reviewer auditing part of a Pi (the `@earendil-works/pi-coding-agent` CLI) extensions monorepo for ERRORS and INCONSISTENCIES.",
	"Hunt for CONCRETE defects: logic bugs, wrong edge cases, concurrency hazards (races, unawaited promises, missing cancellation/cleanup), swallowed/incorrect error handling, type-unsafe casts, unchecked JSON.parse, security (shell injection via string-spawn, secret/env leakage, path traversal, loading code from an untrusted cwd), and inconsistencies (between sibling extensions, between code and its OWN comments/README, stale defaults).",
	"GROUND every finding in code you actually read; if you cannot cite file+line+the exact snippet, do NOT report it. Do not edit anything.",
	"",
	"EFFICIENCY (critical — limited turn budget): do NOT read entire large files top-to-bottom. Use grep/find to locate the specific functions named in your scope, then read ONLY ~60-120 lines around each. Spend the budget on ANALYSIS. You MUST emit your findings block before the turn ends.",
	"",
	"HARD OUTPUT LIMITS (violating these truncates your answer and it is DISCARDED):",
	"- Report AT MOST 8 findings. Prioritize the most severe; drop nitpicks.",
	"- Keep each `issue` under ~350 characters and each `evidence` under ~250 characters. Be terse.",
	"- Output ONLY a single fenced ```json code block with a JSON array and NOTHING else. CLOSE the array (`]`) and the block.",
	'- Each element: {"severity":"high|medium|low","category":"...","file":"repo/rel/path","line":"N or N-M","issue":"...","evidence":"...","suggestion":"..."}. If truly clean, output [].',
	"",
	"Your assigned scope:",
].join("\n");

function item(area, tier, scope) {
	return { label: area, area, phase: "fan-out review", ...TIER[tier], tier, tools: READ_ONLY, prompt: `${PREFIX}\n${scope}` };
}

function parseFindings(text) {
	if (!text) return [];
	const s = typeof text === "string" ? text : (text.output ?? text.text ?? "");
	const block = s.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidates = [];
	if (block) candidates.push(block[1].trim());
	const a = s.indexOf("["), b = s.lastIndexOf("]");
	if (a >= 0 && b > a) candidates.push(s.slice(a, b + 1));
	for (const c of candidates) {
		try {
			const v = JSON.parse(c);
			if (Array.isArray(v)) return v;
			if (Array.isArray(v?.findings)) return v.findings;
		} catch {}
	}
	return [];
}

const rawOf = (r) => (r ? String(r.output ?? r.text ?? r ?? "") : "");
function isEmpty(r) {
	if (!r) return true;
	const raw = rawOf(r);
	if (raw.trim().length < 200) return true;
	return parseFindings(r).length === 0 && !raw.includes("[]");
}

export default async function main() {
	const input = (() => { try { return typeof args === "string" ? JSON.parse(args) || {} : args || {}; } catch { return {}; } })();
	const items = [
		// core-dispatch-b: dual (opus + sonnet) — the untested half of the dispatcher.
		item("core-dispatch-b", "opusHigh", "extensions/pandi-dynamic-workflows/index.ts — review ONLY these functions (grep for each, read ~80-120 lines around it, NEVER read the whole file): journalLookup (resume/journal cache), runSubagent, runBash, runAsk, the makeApi globals factory, and handleTool. Focus on resume/journal correctness, secret redaction, unhandled rejections, and error handling."),
		item("core-dispatch-b", "sonnetHigh", "extensions/pandi-dynamic-workflows/index.ts — review ONLY these functions (grep for each, read ~80-120 lines around it, NEVER read the whole file): journalLookup (resume/journal cache), runSubagent, runBash, runAsk, the makeApi globals factory, and handleTool. Focus on resume/journal correctness, secret redaction, unhandled rejections, and error handling."),
		item("devtools-a", "sonnetHigh", "extensions/pandi-typescript-lsp/*.ts + extensions/pandi-bg/*.ts (skip tests/). Focus on tsc resolution & touched-file scoping, spawn-before-abort races, and bg job lifecycle, PID/identity reuse detection, atomic status writes, and trust gating."),
		item("docs-consistency", "sonnetHigh", "Compare the ROOT README.md claims against actual code: slash-command names, model/tool names, PI_* env-var names AND their defaults, and file paths. Read README.md plus the specific source lines it references. Report each drift with BOTH citations (README line + source line)."),
	];

	const plan = items.map((it) => ({ agent: it.area, model: it.model, effort: it.effort }));
	plan.push({ agent: "synthesis-judge", model: TIER.opusHigh.model, effort: TIER.opusHigh.effort });
	await log("model/effort matrix (anthropic-only)", { plan });
	await writeArtifact("plan.json", plan);

	const requestedConcurrency = Number.isFinite(+input.concurrency) ? Math.max(1, Math.floor(+input.concurrency)) : 4;
	const concurrency = Math.max(1, Math.min(requestedConcurrency, limits.concurrency));
	if (concurrency !== requestedConcurrency) log(`concurrency clamped ${requestedConcurrency} -> ${concurrency} by limits.concurrency=${limits.concurrency}`);
	const recommendedMaxAgents = items.length * 2 + 1;
	if (limits.maxAgents && recommendedMaxAgents > limits.maxAgents) log(`WARNING: maxAgents may be tight for repo-audit-4 ${JSON.stringify({ recommendedMaxAgents, limit: limits.maxAgents, firstPass: items.length, possibleRetries: items.length, synthesis: 1 })}`);
	await log("fan-out (pass 1)", { items: items.length, concurrency, maxAgents: limits.maxAgents, recommendedMaxAgents });
	let results = await agents(items, { concurrency, settle: true });

	const retryIdx = results.map((r, i) => (isEmpty(r) ? i : -1)).filter((i) => i >= 0);
	if (retryIdx.length) {
		await log("retry empties (pass 2, cache:false)", { areas: retryIdx.map((i) => items[i].area) });
		const retryResults = await agents(retryIdx.map((i) => ({ ...items[i], cache: false })), { concurrency, settle: true });
		retryIdx.forEach((origIdx, k) => {
			if (isEmpty(results[origIdx]) && !isEmpty(retryResults[k])) results[origIdx] = retryResults[k];
		});
	}

	const allFindings = [];
	const coverage = [];
	results.forEach((r, i) => {
		const found = isEmpty(r) ? [] : parseFindings(r);
		coverage.push({ area: items[i].area, status: found.length ? "ok" : "empty", findings: found.length, model: items[i].model });
		for (const f of found) allFindings.push({ area: items[i].area, ...f });
	});
	const okCount = coverage.filter((c) => c.status === "ok").length;
	await log("fan-out complete", { ok: okCount, empty: coverage.length - okCount, findings: allFindings.length, coverage });
	await writeArtifact("findings-4.json", allFindings);
	await writeArtifact("coverage-4.json", coverage);

	const synth = [
		"You are the SYNTHESIS JUDGE for the anthropic-only close-out of a read-only repo audit (bugs + inconsistencies).",
		"De-duplicate and prioritize. DROP anything without concrete file/evidence. Rank by severity (high first) then blast radius.",
		"CALIBRATE severity honestly: a displayed-but-not-executed command string is LOW; a spawn-before-abort killed with SIGTERM in the same tick is LOW/MEDIUM.",
		"Be explicit about coverage: which of the areas are still empty.",
		"Output Markdown: `## Resumen` (counts by severity), `## Hallazgos priorizados` (numbered), `## Cobertura`.",
		"",
		"=== COVERAGE (JSON) ===",
		compact(coverage, 4000),
		"",
		"=== FINDINGS (JSON) ===",
		compact(allFindings, 40000),
		"",
		`Areas ok: ${okCount}/${coverage.length}. Restate: dedup, prioritize, calibrate severity, drop unsupported, note remaining empty areas.`,
	].join("\n");
	const report = await agent(synth, { ...TIER.opusHigh, tools: READ_ONLY, phase: "synthesis" });
	await writeArtifact("audit-report-4.md", typeof report === "string" ? report : compact(report, 40000));
	return { ok: okCount, empty: coverage.length - okCount, totalFindings: allFindings.length, plan, coverage, report };
}
