/**
 * dave-test-review (stable; promoted from drafts/ after verified runs) — Dave Farley-lens review of every extension's integration
 * test suites, with a FAIL-FAST PREFLIGHT (issue #5).
 *
 * Failure mode being defended against: under provider rate-limits, fan-out
 * branches can resolve ok:true with EMPTY output. The synthesis judge then
 * (correctly) refuses to fabricate, but the whole run's budget is wasted.
 * Defense in depth:
 *   1. PREFLIGHT: review ONE baseline extension first. If its output is not
 *      substantive after one cache-busted retry, THROW — never fan out.
 *   2. FAN-OUT: every branch is asserted substantive; empties are retried once
 *      with cache:false, then flagged loudly (never silently counted as clean).
 *   3. SYNTHESIS: the judge receives the coverage table and must NAME empty or
 *      failed branches instead of papering over them.
 *
 * Params (args is JSON-stringified; parsed defensively):
 *   extensions  string[]  optional. Explicit extension names; bypasses the scout.
 *   limit       number    default 32. Max extensions reviewed; excess logged & dropped.
 *   concurrency number    default 4 (clamped to limits.concurrency).
 *   baseline    string    optional. Which extension to preflight (default: first sorted).
 *   forceEmpty  string    TEST SEAM, logged loudly. "baseline": the preflight
 *                         branch produces "" on BOTH attempts (must halt before
 *                         fan-out). "once": every branch's FIRST attempt is ""
 *                         (must recover via the cache-busted retry).
 *
 * Reviewers use the project persona `dave-farley` (.pi/personas/dave-farley.json):
 * read-only advisor, modern-software-engineering skill. Explicit model/effort
 * below override the persona defaults per call.
 */
export const meta = {
	name: "dave-test-review",
	description:
		"Dave Farley-lens review of extension integration suites with fail-fast preflight, retry-on-empty, and empty-branch-honest synthesis",
	phases: [{ title: "Scout" }, { title: "Preflight" }, { title: "Fan-out" }, { title: "Synthesize" }],
	basedOn: [
		{ name: "fan-out-and-synthesize", role: "base pattern (scatter-gather + synthesis-as-judge)" },
		{ name: "repo-audit-4", role: "retry-on-empty (cache:false) precedent" },
	],
};

const MIN_SUBSTANTIVE_CHARS = 200;

const PREFIX = [
	"Act as a Dave Farley-style reviewer of a TEST SUITE (you have the modern-software-engineering skill; apply it).",
	"You are reviewing the integration test suites of ONE extension in the pi-dynamic-workflows monorepo.",
	"Judge the suites as ENGINEERING ARTIFACTS: do they optimize for learning and manage complexity?",
	"Evaluate concretely:",
	"- BEHAVIORAL coverage: do tests pin observable behavior (outputs, messages, state) or implementation detail?",
	"- NON-VACUITY: could a test pass while the behavior is broken? Name any assertion that cannot fail meaningfully.",
	"- HERMETICITY: hidden network/global-state/timing dependencies; anything that could flake under parallelism.",
	"- FEEDBACK SPEED: sleeps, oversized fixtures, serial work that could be cheap.",
	"- GAPS: the most important UNTESTED behaviors of this extension (read the source to know what it does).",
	"GROUND every claim in file+line evidence you actually read. Do NOT edit anything.",
	"EFFICIENCY: use grep/find to navigate; read only the regions you need. Emit your report before the turn ends.",
	"",
	"OUTPUT FORMAT (Markdown, ALL sections required, keep it under ~500 lines):",
	"## VERDICT — one of: STRONG | ADEQUATE | WEAK, plus a one-sentence justification",
	"## STRENGTHS — bullet list with evidence",
	"## GAPS — prioritized, most important first, each with the missing behavior + why it matters",
	"## FLAKINESS RISKS — or 'none found'",
	"## RECOMMENDATIONS — smallest safe next steps, TDD-first",
	"",
	"Your assigned extension:",
].join("\n");

export default async function main() {
	const input = (() => {
		try {
			return typeof args === "string" ? JSON.parse(args) || {} : args || {};
		} catch {
			return {};
		}
	})();

	const compact = (d, n = 60000) => {
		const s = typeof d === "string" ? d : JSON.stringify(d);
		return s.length > n ? `${s.slice(0, n)} …[truncated]` : s;
	};

	const REVIEWER = { agentType: "dave-farley", model: "anthropic/claude-sonnet-4-6", effort: "medium" };
	const JUDGE = { agentType: "dave-farley", model: "anthropic/claude-opus-4-8", effort: "high" };

	// --- Scout: constant command (no interpolation), grouped by extension. -----
	phase("Scout");
	const lsOut = await bash("git ls-files 'extensions/*/tests/integration/*.test.mjs'");
	const suites = String(lsOut?.stdout ?? lsOut ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const byExt = new Map();
	for (const suite of suites) {
		const ext = suite.split("/")[1];
		if (!ext) continue;
		const list = byExt.get(ext) ?? [];
		list.push(suite);
		byExt.set(ext, list);
	}
	let extNames = [...byExt.keys()].sort();
	if (Array.isArray(input?.extensions) && input.extensions.length) {
		const requested = input.extensions.filter((e) => byExt.has(e));
		const unknown = input.extensions.filter((e) => !byExt.has(e));
		if (unknown.length) await log("ignoring unknown extensions", { unknown });
		extNames = requested;
	}
	const limit = Math.max(1, Math.min(256, Math.floor(Number(input?.limit) || 32)));
	if (extNames.length > limit) {
		await log("limit cap applied — extensions DROPPED from this run", {
			reviewed: limit,
			dropped: extNames.slice(limit),
		});
		extNames = extNames.slice(0, limit);
	}
	if (extNames.length === 0) throw new Error("Scout found no extension integration suites to review.");
	await log("work-list", { extensions: extNames.length, suites: suites.length });

	// --- Substantive-output assertion + retry-on-empty (the #5 core). ----------
	const forceEmpty = input?.forceEmpty === "baseline" || input?.forceEmpty === "once" ? input.forceEmpty : null;
	if (forceEmpty) await log(`TEST SEAM ACTIVE: forceEmpty=${forceEmpty} — simulating empty branch output`);

	const isSubstantive = (out) => typeof out === "string" && out.trim().length >= MIN_SUBSTANTIVE_CHARS;

	const prompt = (ext) => `${PREFIX}\n${ext} — suites:\n${byExt.get(ext).join("\n")}`;

	// One review attempt. The seam simulates the observed failure (ok:true, empty
	// output) WITHOUT spending an agent call.
	const reviewOnce = async (ext, { cache = true, attempt, phaseTitle }) => {
		if (forceEmpty === "baseline" && phaseTitle === "Preflight") return "";
		if (forceEmpty === "once" && attempt === 1) return "";
		const out = await agent(prompt(ext), {
			...REVIEWER,
			cache,
			label: `review-${ext}${attempt > 1 ? "-retry" : ""}`,
			phase: phaseTitle,
		});
		return typeof out === "string" ? out : (out?.output ?? out?.text ?? "");
	};

	// Attempt + one cache-busted retry; returns { ext, output|null, empty, retried }.
	const reviewWithRetry = async (ext, phaseTitle) => {
		let out = await reviewOnce(ext, { attempt: 1, phaseTitle });
		let retried = false;
		if (!isSubstantive(out)) {
			await log(`EMPTY branch output for ${ext} — retrying once with cache:false`, {
				chars: String(out ?? "").trim().length,
			});
			retried = true;
			out = await reviewOnce(ext, { cache: false, attempt: 2, phaseTitle });
		}
		if (!isSubstantive(out)) {
			await log(`EMPTY branch output for ${ext} AFTER retry — flagged as failed`, {
				chars: String(out ?? "").trim().length,
			});
			return { ext, output: null, empty: true, retried };
		}
		return { ext, output: out, empty: false, retried };
	};

	// --- PREFLIGHT: one baseline extension BEFORE any fan-out spend. -----------
	phase("Preflight");
	const baseline = typeof input?.baseline === "string" && extNames.includes(input.baseline) ? input.baseline : extNames[0];
	await log("preflight baseline", { baseline });
	const canary = await reviewWithRetry(baseline, "Preflight");
	if (canary.empty) {
		await writeArtifact("preflight-failure.json", { baseline, retried: canary.retried, forceEmpty });
		throw new Error(
			`PREFLIGHT FAILED: baseline review of ${baseline} produced empty output even after a cache-busted retry ` +
				"(likely rate-limiting). Aborting BEFORE the fan-out — nothing else was spent. Re-run later or switch models.",
		);
	}
	await writeArtifact(`review-${baseline}.md`, canary.output);
	await log("preflight PASS", { baseline, chars: canary.output.length, retried: canary.retried });

	// --- Fan-out over the remaining extensions. --------------------------------
	phase("Fan-out");
	const rest = extNames.filter((e) => e !== baseline);
	const concurrency = Math.max(1, Math.min(Number(input?.concurrency) || 4, limits.concurrency));
	await log("fan-out", { extensions: rest.length, concurrency, maxAgents: limits.maxAgents });
	const settled = await parallel(
		rest.map((ext) => () => reviewWithRetry(ext, "Fan-out")),
		{ concurrency },
	);
	// parallel(settle-like): a thrown branch is null — recover its identity positionally.
	const results = [canary, ...settled.map((r, i) => r ?? { ext: rest[i], output: null, empty: true, retried: false })];

	const coverage = results.map((r) => ({
		ext: r.ext,
		status: r.empty ? "EMPTY" : "ok",
		retried: r.retried,
		chars: r.output ? r.output.length : 0,
	}));
	const empties = coverage.filter((c) => c.status === "EMPTY").map((c) => c.ext);
	for (const r of results) if (r.output && r.ext !== baseline) await writeArtifact(`review-${r.ext}.md`, r.output);
	await writeArtifact("coverage.json", coverage);
	await log("fan-out complete", { ok: results.length - empties.length, empty: empties.length, empties });

	// --- Synthesis-as-judge: empty branches are NAMED, never papered over. ------
	phase("Synthesize");
	const reviewed = results.filter((r) => !r.empty);
	const synth = [
		"You are the SYNTHESIS JUDGE for a Dave Farley-lens review of extension test suites (reports below).",
		"Task + success criteria: produce ONE prioritized, evidence-grounded report. Discard any claim without file/line evidence. De-duplicate cross-extension themes.",
		`Coverage: ${reviewed.length}/${results.length} extensions reviewed. EMPTY/FAILED branches you MUST name as unreviewed (never infer anything about them): ${empties.length ? JSON.stringify(empties) : "none"}.`,
		"Output Markdown: `## Resumen` (verdict counts, systemic themes), `## Hallazgos priorizados` (numbered, most valuable first, with extension + evidence), `## Cobertura` (per-extension verdict table, EMPTY branches marked), `## Próximos pasos` (smallest safe TDD-first steps).",
		"",
		"=== COVERAGE (JSON) ===",
		compact(coverage, 4000),
		"",
		"=== REVIEWS ===",
		compact(
			reviewed.map((r) => `### ${r.ext}\n${r.output}`).join("\n\n"),
			120000,
		),
		"",
		`Restate: prioritize with evidence, de-duplicate themes, and explicitly name the ${empties.length} EMPTY branch(es)${empties.length ? `: ${JSON.stringify(empties)}` : ""}.`,
	].join("\n");
	const report = await agent(synth, { ...JUDGE, label: "synthesis-judge", phase: "Synthesize" });
	await writeArtifact("test-review-report.md", typeof report === "string" ? report : compact(report, 80000));

	return {
		baseline,
		reviewed: reviewed.length,
		empty: empties.length,
		empties,
		coverage,
		report,
	};
}
