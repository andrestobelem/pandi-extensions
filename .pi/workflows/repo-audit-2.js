// TEMP repo-audit-2 (delete after): covers the 5 areas that returned empty output in run 1.
// Root cause of run-1 failures: heavy areas produced very verbose findings whose JSON output
// exceeded the token budget and was TRUNCATED mid-string -> strict schema parse failed -> retries failed.
// Fixes here: small per-extension/file-cluster scopes, NO strict schema (lenient JSON-block parse),
// a HARD verbosity cap (short issue/evidence + max findings) so the JSON always terminates,
// an explicit model/effort matrix per agent (logged + saved as an artifact), and correct
// area-label alignment (iterate WITH nulls so filtered branches never shift labels).

export const meta = {
	name: "repo-audit-2",
	description: "Robust re-audit of the heavy areas.",
	phases: [{ title: "fan-out review" }, { title: "synthesis" }],
};

const READ_ONLY = ["read", "grep", "find", "ls"];

// model/effort tiers across BOTH authenticated providers (anthropic + openai-codex) for
// cross-provider adversarial diversity. Reported to the user and logged so the run is self-describing.
const TIER = {
	opusHigh: { model: "anthropic/claude-opus-4-8", effort: "high" },
	sonnetHigh: { model: "anthropic/claude-sonnet-4-6", effort: "high" },
	sonnetMed: { model: "anthropic/claude-sonnet-4-6", effort: "medium" },
	codexHigh: { model: "openai-codex/gpt-5.5", effort: "high" },
	codexMed: { model: "openai-codex/gpt-5.4", effort: "medium" },
};

const PREFIX = [
	"You are a meticulous, ADVERSARIAL code reviewer auditing part of a Pi (the `@earendil-works/pi-coding-agent` CLI) extensions monorepo for ERRORS and INCONSISTENCIES.",
	"Read (read-only) ONLY the files in your assigned scope and hunt for CONCRETE defects: logic bugs, wrong edge cases, concurrency hazards (races, unawaited promises, missing cancellation/cleanup), swallowed/incorrect error handling, type-unsafe casts, unchecked JSON.parse, security (shell injection via string-spawn, secret/env leakage, path traversal), and inconsistencies (between sibling extensions, between code and its OWN comments/README, stale defaults).",
	"GROUND every finding in code you actually read; if you cannot cite file+line+the exact snippet, do NOT report it. Do not edit anything.",
	"",
	"HARD OUTPUT LIMITS (critical — violating these truncates your answer and it is DISCARDED):",
	"- Report AT MOST 8 findings. Prioritize the most severe; drop nitpicks.",
	"- Keep each `issue` under ~350 characters and each `evidence` under ~250 characters. Be terse; no essays.",
	"- Output ONLY a single fenced ```json code block with a JSON array and NOTHING else. CLOSE the array (`]`) and the block.",
	"- Each element: {\"severity\":\"high|medium|low\",\"category\":\"...\",\"file\":\"repo/rel/path\",\"line\":\"N or N-M\",\"issue\":\"...\",\"evidence\":\"...\",\"suggestion\":\"...\"}. If clean, output [].",
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

export default async function main() {
	// Scope strings (reused so the 3 CORE areas can be reviewed by BOTH providers).
	const S = {
		coreDispatch: "extensions/pi-dynamic-workflows/index.ts — the subagent dispatcher, journal/resume cache, runSubagent/runAsk/runBash, makeApi globals, handleTool. Focus on cancellation, resume/journal correctness, and secret redaction.",
		corePrimitives: "extensions/pi-dynamic-workflows/concurrency-primitives.ts + process-spawn.ts + worker-source.ts. Focus on race()/agents()/parallel()/pipeline() cancellation & error propagation, AbortSignal wiring, and child-process spawn (argv vs shell) safety.",
		coreEnvResume: "extensions/pi-dynamic-workflows/agent-env-persona.ts + config.ts + run-lifecycle.ts + run-state.ts. Focus on keys/env isolation & redaction, web_search/context7 resolution, limit clamps, and atomic status/result writes.",
	};
	const items = [
		// CORE (critical) — dual, cross-provider: anthropic opus + openai-codex gpt-5.5.
		item("core-dispatch", "opusHigh", S.coreDispatch),
		item("core-dispatch", "codexHigh", S.coreDispatch),
		item("core-primitives", "opusHigh", S.corePrimitives),
		item("core-primitives", "codexHigh", S.corePrimitives),
		item("core-env-resume", "opusHigh", S.coreEnvResume),
		item("core-env-resume", "codexHigh", S.coreEnvResume),
		// loops/goal/plan — single reviewer, alternate providers.
		item("pi-loop", "codexHigh", "extensions/pi-loop/*.ts (skip tests/). Focus on state rehydration, delay/iteration/deadline clamps, tui/rpc gating, watchdog force-stop, autopilotTurnInFlight lifecycle vs activeLoops, and GC of terminal state."),
		item("pi-goal", "sonnetHigh", "extensions/pi-goal/*.ts (skip tests/). Focus on activeGoals cleanup on stop/shutdown, sidecar write-vs-read symmetry, independent-verifier gating & caps, and iteration/wait clamps."),
		item("pi-plan", "codexHigh", "extensions/pi-plan/*.ts (skip tests/). Focus on read-only mutation gate enforcement, blocked dynamic_workflow actions, bash allowlist, and non-interactive plan-only handling."),
		// devtools + docs/config — single reviewer, alternate providers, medium effort.
		item("devtools-a", "sonnetMed", "extensions/pi-typescript-lsp/*.ts + extensions/pi-bg/*.ts (skip tests/). Focus on tsc resolution & touched-file scoping, and bg job lifecycle, PID/identity reuse detection, atomic writes, trust gating."),
		item("devtools-b", "codexMed", "extensions/pi-worktree/*.ts + extensions/pi-container/*.ts (skip tests/). Focus on argv-array (never shell) git/container spawning, platform guards, and never-force-delete defaults."),
		item("docs-consistency", "codexMed", "Compare the ROOT README.md claims against actual code: slash-command names, model tool names, PI_* env-var names AND defaults, and file paths. Read README.md plus the specific source lines it references. Report each drift with both citations."),
		item("config-manifest", "sonnetMed", "package.json (`pi.extensions` vs extensions/ dirs, `files`, `pi.skills`, scripts), biome.jsonc, tsconfig.json, .gitignore, .env.example vs actual PI_* usage, and pi scaffolds vs .claude/workflows (parity). Report mismatches with citations."),
	];

	// Self-describing run: log + persist the model/effort matrix so it shows in events.jsonl / the dashboard.
	const plan = items.map((it) => ({ agent: it.area, model: it.model, effort: it.effort, tier: it.tier }));
	plan.push({ agent: "synthesis-judge", model: TIER.opusHigh.model, effort: TIER.opusHigh.effort, tier: "opusHigh" });
	await log("model/effort matrix", { plan });
	await writeArtifact("plan.json", plan);

	const concurrency = Math.min(4, limits.concurrency);
	await log("fan-out", { items: items.length, concurrency, maxAgents: limits.maxAgents });
	const results = await agents(items, { concurrency, settle: true });

	const allFindings = [];
	let failed = 0;
	const coverage = [];
	results.forEach((r, i) => {
		if (!r) { failed++; coverage.push({ area: items[i].area, status: "failed", model: items[i].model, effort: items[i].effort }); return; }
		const found = parseFindings(r?.output ?? r?.text ?? r);
		coverage.push({ area: items[i].area, status: found.length ? "ok" : "empty", findings: found.length, model: items[i].model, effort: items[i].effort });
		for (const f of found) allFindings.push({ area: items[i].area, ...f });
	});
	await log("fan-out complete", { ok: results.length - failed, failed, findings: allFindings.length, coverage });
	await writeArtifact("findings-2.json", allFindings);
	await writeArtifact("coverage-2.json", coverage);

	const synth = [
		"You are the SYNTHESIS JUDGE for the second pass of a read-only repo audit (bugs + inconsistencies).",
		"De-duplicate and prioritize the findings below. DROP anything without concrete file/evidence. Rank by severity (high first) then blast radius. For each kept finding: severity, category, file:line, what's wrong, why it matters, concrete fix.",
		"Be explicit about coverage: which branches were ok/empty/failed (see coverage JSON).",
		"Output Markdown: `## Resumen` (counts by severity), `## Hallazgos priorizados` (numbered), `## Cobertura`.",
		"",
		"=== COVERAGE (JSON) ===",
		compact(coverage, 4000),
		"",
		"=== FINDINGS (JSON) ===",
		compact(allFindings, 40000),
		"",
		`Branches ok: ${results.length - failed}/${results.length}. Restate: dedup, prioritize by severity, drop unsupported, be explicit about coverage gaps.`,
	].join("\n");
	const report = await agent(synth, { ...TIER.opusHigh, tools: READ_ONLY, phase: "synthesis" });
	await writeArtifact("audit-report-2.md", typeof report === "string" ? report : compact(report, 40000));
	return { areasOk: results.length - failed, areasFailed: failed, totalFindings: allFindings.length, plan, coverage, report };
}
