// TEMP repo-audit (delete after): read-only review for errors & inconsistencies.
// 1) Deterministic gate (bash): typecheck + biome + markdownlint, captured as evidence.
// 2) Fan-out reviewers over extension groups + a doc-consistency + a config/manifest branch.
// 3) Synthesis-as-judge (opus): dedup, drop unsupported, prioritize by severity.
// All subagents are READ-ONLY. Grounded in file:line evidence.

export const meta = {
	name: "repo-audit",
	description: "Read-only audit of the repo for bugs and inconsistencies; ranked, evidence-backed report.",
	phases: 3,
};

const READ_ONLY = ["read", "grep", "find", "ls"];

const FINDINGS_SCHEMA = {
	type: "object",
	required: ["findings"],
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				required: ["severity", "category", "file", "issue"],
				properties: {
					severity: { type: "string", enum: ["high", "medium", "low"] },
					category: { type: "string" },
					file: { type: "string" },
					line: { type: "string" },
					issue: { type: "string" },
					evidence: { type: "string" },
					suggestion: { type: "string" },
				},
			},
		},
		note: { type: "string" },
	},
};

const REVIEW_PREFIX = [
	"You are a meticulous, ADVERSARIAL code reviewer auditing a monorepo of Pi (the `@earendil-works/pi-coding-agent` CLI) extensions for ERRORS and INCONSISTENCIES.",
	"Read (read-only) the files in your assigned area and hunt for CONCRETE defects:",
	"- Logic bugs, wrong edge-case handling, off-by-one, incorrect conditionals, unreachable/contradictory code.",
	"- Concurrency hazards: races, unawaited promises, shared-state mutation, missing cancellation/cleanup, resource/handle leaks.",
	"- Error handling: swallowed errors, unhandled rejections, throw/return mismatches, misleading messages.",
	"- Type-unsafe casts (`as any`, non-null `!` on maybe-undefined), unchecked JSON.parse, unvalidated input.",
	"- Security: shell injection (string vs argv spawn), secret/env leakage into logs/artifacts, path traversal.",
	"- Inconsistencies: between sibling extensions, between code and its OWN comments/JSDoc/README, between declared and actual behavior, stale/incorrect defaults.",
	"For EACH finding return: severity (high|medium|low), category, file (repo-relative path), line (number or range), issue (what is wrong), evidence (the exact code/quote that proves it), suggestion (a concrete fix).",
	"GROUND every finding in the actual code you read. If you cannot cite it, do NOT report it. If the area is clean, return findings: [] with a short note on what you checked.",
	"Do NOT invent issues, do NOT speculate, do NOT edit anything.",
	"",
	"Your assigned area:",
].join("\n");

function reviewItem(label, description, model = "anthropic/claude-sonnet-4-6") {
	return {
		label,
		model,
		effort: "high",
		tools: READ_ONLY,
		schema: FINDINGS_SCHEMA,
		prompt: `${REVIEW_PREFIX}\n${description}`,
	};
}

export default async function main() {
	await log("repo-audit start", { concurrency: limits.concurrency, maxAgents: limits.maxAgents });

	// 1) Deterministic gate — cheap, high-signal grounding (not cached: reflects current tree).
	const gate = await bash(
		[
			"echo '===TYPECHECK==='; npm run typecheck --silent 2>&1 | tail -30 || true",
			"echo '===BIOME==='; npx biome check . 2>&1 | tail -40 || true",
			"echo '===MARKDOWNLINT==='; npx markdownlint-cli2 2>&1 | tail -40 || true",
		].join("; "),
		{ cache: false },
	);
	await writeArtifact("gate.txt", gate?.stdout || String(gate || ""));
	await log("deterministic gate captured", {});

	// 2) Fan-out review areas.
	const areas = [
		reviewItem(
			"core-runtime",
			"The Dynamic Workflows CORE runtime. Prioritize the highest-risk files: extensions/pi-dynamic-workflows/index.ts (subagent dispatcher, journal/resume, runAsk/runBash/runSubagent, makeApi, handleTool), concurrency-primitives.ts (race/agents/parallel/pipeline cancellation), process-spawn.ts, agent-env-persona.ts (keys/env isolation, web_search/context7 resolution), worker-source.ts, types.ts. Focus on concurrency, cancellation, resume/journal correctness, and secret handling.",
			"anthropic/claude-opus-4-8",
		),
		reviewItem(
			"loops-goal-plan",
			"Persistent-loop extensions: extensions/pi-loop, extensions/pi-goal, extensions/pi-plan. Review each *.ts (skip tests/). Focus on state rehydration, iteration/deadline clamps, trust/mode gating, plan-mode read-only enforcement, and verifier/gate logic.",
		),
		reviewItem(
			"context-effort",
			"extensions/pi-effort, extensions/pi-local-memory, extensions/pi-auto-compact, extensions/pi-btw. Review each *.ts (skip tests/). Focus on env-var parsing/defaults, memory injection safety, compaction/snapshot correctness, and no-tools guarantees.",
		),
		reviewItem(
			"devtools",
			"extensions/pi-typescript-lsp, extensions/pi-worktree, extensions/pi-container, extensions/pi-bg. Review each *.ts (skip tests/). Focus on argv-vs-shell spawning, PID/identity handling, tsc resolution, container platform guards, and bg job lifecycle/atomic writes.",
		),
		reviewItem(
			"ux-aliases",
			"extensions/pi-mdview, extensions/pi-rename, extensions/pi-pandi, extensions/pi-exit, extensions/pi-clear, and extensions/shared. Review each *.ts (skip tests/). Focus on alias coexistence (never override native), timeouts/fallbacks, and shared harness helpers.",
		),
		reviewItem(
			"docs-consistency",
			"DOC/CODE consistency. Compare claims in the root README.md and each extensions/*/README.md against the ACTUAL code: slash-command names, model tool names, env-var names AND defaults, file paths, and documented behavior. Report every drift (README says X, code does Y) with both citations. Also flag internal contradictions across docs.",
		),
		reviewItem(
			"config-manifest",
			"CONFIG/MANIFEST consistency. Check: package.json `pi.extensions` vs the actual extensions/ dirs (missing/extra); `files` vs what must ship; scripts correctness; `pi.skills` vs skills on disk; biome.jsonc + .gitignore + tsconfig.json coherence; the pi scaffolds (extensions/pi-dynamic-workflows/scaffolds/*.js) vs the generated .claude/workflows/*.js (run `node .claude/scripts/generate-claude-workflows.mjs --check` mentally / by reading); .env.example vs actual PI_* usage. Report mismatches with citations.",
		),
	];

	const concurrency = Math.min(4, limits.concurrency);
	await log("review fan-out", { areas: areas.length, concurrency });
	const reviews = await agents(areas, { concurrency, settle: true });
	const ok = reviews.filter(Boolean);
	const failed = reviews.length - ok.length;
	await log("reviews complete", { ok: ok.length, failed });

	const allFindings = [];
	ok.forEach((r, i) => {
		const data = r?.data || r?.output || r;
		const arr = Array.isArray(data?.findings) ? data.findings : [];
		for (const f of arr) allFindings.push({ area: areas[i]?.label, ...f });
	});
	await writeArtifact("raw-findings.json", allFindings);
	await log("findings collected", { total: allFindings.length });

	// 3) Synthesis-as-judge.
	const synthPrompt = [
		"You are the SYNTHESIS JUDGE for a read-only repo audit (bugs + inconsistencies) of a Pi extensions monorepo.",
		"Task: from the raw findings and the deterministic gate output below, produce a de-duplicated, prioritized report.",
		"Rules: DROP any finding without concrete file/evidence. Merge duplicates across areas. Rank by severity (high first) then blast radius. For each kept finding give: severity, category, file:line, what's wrong, why it matters, and a concrete fix. Separately list anything that looks like ANOTHER SESSION'S in-flight WIP (e.g. open-prose skill, skills-lock churn) so the reader does not confuse it with real defects.",
		"Be honest about coverage: mention how many review branches failed/were empty and what was NOT covered.",
		"Output Markdown with sections: `## Resumen` (counts by severity), `## Hallazgos priorizados` (numbered), `## Gate determinista` (typecheck/biome/markdownlint status), `## Posible WIP ajeno`, `## Cobertura y límites`.",
		"",
		"=== DETERMINISTIC GATE OUTPUT ===",
		compact(gate?.stdout || String(gate || ""), 8000),
		"",
		"=== RAW FINDINGS (JSON) ===",
		compact(allFindings, 40000),
		"",
		`Branches: ${ok.length} ok, ${failed} failed of ${reviews.length}. Restate: dedup + prioritize by severity, drop unsupported, separate in-flight WIP, be explicit about coverage gaps.`,
	].join("\n");

	const report = await agent(synthPrompt, { model: "anthropic/claude-opus-4-8", effort: "high", tools: READ_ONLY });
	await writeArtifact("audit-report.md", typeof report === "string" ? report : compact(report, 40000));
	await log("synthesis done", {});
	return { areas: areas.length, reviewsFailed: failed, totalFindings: allFindings.length, report };
}
