// TEMP repo-audit-3 (delete after): targeted re-audit of the 6 areas that came back EMPTY in run 2.
// Root cause of the empties: "empty JSON event stream" — the JSON-output subagent exhausts its turn
// (especially core-dispatch = index.ts ~1700 lines: reading the whole file eats the turn before it
// can emit findings). Mitigations here:
//   1. core-dispatch is SPLIT into two function-focused shards that MUST use grep + targeted reads
//      (never read the whole file), so the turn budget is spent on analysis, not scrolling.
//   2. retry-on-empty: any shard whose output is empty/near-empty is re-run ONCE with cache:false
//      (the empty-stream is transient; a plain re-run would hit the agent() cache and repeat it).
//   3. all shards at effort high; docs/devtools bumped from medium.
// Same lenient JSON-block parse + verbosity cap + correct label alignment as repo-audit-2.

export const meta = {
	name: "repo-audit-3",
	description: "Targeted re-audit of the 6 empty areas.",
	phases: [{ title: "fan-out review" }, { title: "synthesis" }],
};

const READ_ONLY = ["read", "grep", "find", "ls"];

const TIER = {
	opusHigh: { model: "anthropic/claude-opus-4-8", effort: "high" },
	sonnetHigh: { model: "anthropic/claude-sonnet-4-6", effort: "high" },
	codexHigh: { model: "openai-codex/gpt-5.5", effort: "high" },
	codexMedPlus: { model: "openai-codex/gpt-5.4", effort: "high" },
};

const PREFIX = [
	"You are a meticulous, ADVERSARIAL code reviewer auditing part of a Pi (the `@earendil-works/pi-coding-agent` CLI) extensions monorepo for ERRORS and INCONSISTENCIES.",
	"Hunt for CONCRETE defects: logic bugs, wrong edge cases, concurrency hazards (races, unawaited promises, missing cancellation/cleanup), swallowed/incorrect error handling, type-unsafe casts, unchecked JSON.parse, security (shell injection via string-spawn, secret/env leakage, path traversal, loading code from an untrusted cwd), and inconsistencies (between sibling extensions, between code and its OWN comments/README, stale defaults).",
	"GROUND every finding in code you actually read; if you cannot cite file+line+the exact snippet, do NOT report it. Do not edit anything.",
	"",
	"EFFICIENCY (critical — you have a limited turn budget): do NOT read entire large files top-to-bottom. Use grep/find to locate the specific functions named in your scope, then read ONLY ~60-120 lines around each. Spend your budget on ANALYSIS, not scrolling. You MUST emit your findings block before the turn ends.",
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
// "empty" = branch failed, OR near-empty output (the empty-stream mode), OR parsed 0 without an explicit [].
function isEmpty(r) {
	if (!r) return true;
	const raw = rawOf(r);
	if (raw.trim().length < 200) return true;
	return parseFindings(r).length === 0 && !raw.includes("[]");
}

export default async function main() {
	const input = (() => { try { return typeof args === "string" ? JSON.parse(args) || {} : args || {}; } catch { return {}; } })();
	const items = [
		// core-dispatch SPLIT into two function-focused shards (targeted reads, never the whole file).
		item("core-dispatch-a", "opusHigh", "extensions/pi-dynamic-workflows/index.ts — review ONLY these functions (grep for each, read ~80-120 lines around it, do NOT read the whole file): the callSignal AbortSignal ALS, callControllers, the dispatcher, the agent()/ask() call wrap, and runWorkflow. Focus on cancellation wiring, AbortSignal lifecycle, and per-call isolation."),
		item("core-dispatch-b", "codexHigh", "extensions/pi-dynamic-workflows/index.ts — review ONLY these functions (grep for each, read ~80-120 lines around it, do NOT read the whole file): journalLookup (resume/journal cache), runSubagent, runBash, runAsk, the makeApi globals factory, and handleTool. Focus on resume/journal correctness, secret redaction, and error handling."),
		// pi-loop: known real bug last time (autopilotTurnInFlight gate-bypass); high effort.
		item("pi-loop", "codexHigh", "extensions/pi-loop/*.ts (skip tests/). Focus HARD on: stopLoop vs the module-level autopilotTurnInFlight flag and inFlightOwnerAlive(), drainWakeQueue guards, the agent_end reset of loop.autopilot, state rehydration, delay/iteration/deadline clamps, tui/rpc gating, watchdog force-stop, and GC of terminal state."),
		// pi-goal: sonnet came back empty last time — give it high effort + a second (codex) reviewer.
		item("pi-goal", "sonnetHigh", "extensions/pi-goal/*.ts (skip tests/). Focus on activeGoals cleanup on stop/shutdown (delete/clear symmetry vs pi-loop), sidecar write-vs-read symmetry, independent-verifier gating & caps, use-after-shutdown of in-flight verifiers, and iteration/wait clamps."),
		item("pi-goal", "codexHigh", "extensions/pi-goal/*.ts (skip tests/). Focus on activeGoals cleanup on stop/shutdown (delete/clear symmetry vs pi-loop), sidecar write-vs-read symmetry, independent-verifier gating & caps, use-after-shutdown of in-flight verifiers, and iteration/wait clamps."),
		// devtools-a: bumped to high effort; its twin devtools-b found 8.
		item("devtools-a", "sonnetHigh", "extensions/pi-typescript-lsp/*.ts + extensions/pi-bg/*.ts (skip tests/). Focus on tsc resolution & touched-file scoping, spawn-before-abort races, and bg job lifecycle, PID/identity reuse detection, atomic status writes, and trust gating."),
		// docs + config: bumped to high effort.
		item("docs-consistency", "codexMedPlus", "Compare the ROOT README.md claims against actual code: slash-command names, model/tool names, PI_* env-var names AND their defaults, and file paths. Read README.md plus the specific source lines it references. Report each drift with BOTH citations (README line + source line)."),
		item("config-manifest", "sonnetHigh", "package.json (`pi.extensions` vs extensions/ dirs, `files`, `pi.skills`, scripts), biome.jsonc, tsconfig.json, .gitignore, .env.example vs actual PI_* usage in code, and pi scaffolds vs .claude/workflows (parity). Report mismatches with citations."),
	];

	const plan = items.map((it) => ({ agent: it.area, model: it.model, effort: it.effort }));
	plan.push({ agent: "synthesis-judge", model: TIER.opusHigh.model, effort: TIER.opusHigh.effort });
	await log("model/effort matrix", { plan });
	await writeArtifact("plan.json", plan);

	const requestedConcurrency = Number.isFinite(+input.concurrency) ? Math.max(1, Math.floor(+input.concurrency)) : 4;
	const concurrency = Math.max(1, Math.min(requestedConcurrency, limits.concurrency));
	if (concurrency !== requestedConcurrency) log(`concurrency clamped ${requestedConcurrency} -> ${concurrency} by limits.concurrency=${limits.concurrency}`);
	const recommendedMaxAgents = items.length * 2 + 1;
	if (limits.maxAgents && recommendedMaxAgents > limits.maxAgents) log(`WARNING: maxAgents may be tight for repo-audit-3 ${JSON.stringify({ recommendedMaxAgents, limit: limits.maxAgents, firstPass: items.length, possibleRetries: items.length, synthesis: 1 })}`);
	await log("fan-out (pass 1)", { items: items.length, concurrency, maxAgents: limits.maxAgents, recommendedMaxAgents });
	let results = await agents(items, { concurrency, settle: true });

	// Retry-on-empty ONCE with cache:false (the empty-stream is transient; cached re-run would repeat it).
	const retryIdx = results.map((r, i) => (isEmpty(r) ? i : -1)).filter((i) => i >= 0);
	if (retryIdx.length) {
		await log("retry empties (pass 2, cache:false)", { areas: retryIdx.map((i) => items[i].area) });
		const retryItems = retryIdx.map((i) => ({ ...items[i], cache: false }));
		const retryResults = await agents(retryItems, { concurrency, settle: true });
		retryIdx.forEach((origIdx, k) => {
			// keep whichever attempt produced findings
			if (isEmpty(results[origIdx]) && !isEmpty(retryResults[k])) results[origIdx] = retryResults[k];
		});
	}

	const allFindings = [];
	const coverage = [];
	results.forEach((r, i) => {
		const found = isEmpty(r) ? [] : parseFindings(r);
		coverage.push({ area: items[i].area, status: found.length ? "ok" : "empty", findings: found.length, model: items[i].model, effort: items[i].effort });
		for (const f of found) allFindings.push({ area: items[i].area, ...f });
	});
	const okCount = coverage.filter((c) => c.status === "ok").length;
	await log("fan-out complete", { ok: okCount, empty: coverage.length - okCount, findings: allFindings.length, coverage });
	await writeArtifact("findings-3.json", allFindings);
	await writeArtifact("coverage-3.json", coverage);

	const synth = [
		"You are the SYNTHESIS JUDGE for a TARGETED re-audit (bugs + inconsistencies) of areas that previously produced no output.",
		"De-duplicate and prioritize. DROP anything without concrete file/evidence. Rank by severity (high first) then blast radius. For each kept finding: severity, category, file:line, what's wrong, why it matters, concrete fix.",
		"CALIBRATE severity honestly: a suggested command STRING that is only displayed (not executed) is LOW, not high; a spawn-before-abort that is SIGTERM-killed in the same tick is LOW/MEDIUM.",
		"Be explicit about coverage: which areas are still empty after the retry (see coverage JSON).",
		"Output Markdown: `## Resumen` (counts by severity), `## Hallazgos priorizados` (numbered), `## Cobertura`.",
		"",
		"=== COVERAGE (JSON) ===",
		compact(coverage, 4000),
		"",
		"=== FINDINGS (JSON) ===",
		compact(allFindings, 40000),
		"",
		`Areas ok: ${okCount}/${coverage.length}. Restate: dedup, prioritize by severity, calibrate severity, drop unsupported, be explicit about remaining empty areas.`,
	].join("\n");
	const report = await agent(synth, { ...TIER.opusHigh, tools: READ_ONLY, phase: "synthesis" });
	await writeArtifact("audit-report-3.md", typeof report === "string" ? report : compact(report, 40000));
	return { ok: okCount, empty: coverage.length - okCount, totalFindings: allFindings.length, plan, coverage, report };
}
