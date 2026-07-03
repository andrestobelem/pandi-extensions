/**
 * dave-design-review (stable; sibling of dave-test-review) — Dave Farley-lens
 * DESIGN review of every extension's source, with the same fail-fast preflight
 * machinery verified in dave-test-review (issue #5): baseline canary before any
 * fan-out spend, substantive-output assertion with one cache-busted retry per
 * branch, and a synthesis judge that must NAME empty/failed branches.
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
	name: "dave-design-review",
	description:
		"Dave Farley-lens design review of extension source with fail-fast preflight, retry-on-empty, and empty-branch-honest synthesis",
	phases: [{ title: "Scout" }, { title: "Preflight" }, { title: "Fan-out" }, { title: "Synthesize" }],
	basedOn: [
		{ name: "dave-test-review", role: "shared skeleton (preflight + retry-on-empty, verified in issue #5 runs)" },
		{ name: "fan-out-and-synthesize", role: "base pattern (scatter-gather + synthesis-as-judge)" },
	],
};

const MIN_SUBSTANTIVE_CHARS = 200;

const PREFIX = [
	"Act as a Dave Farley-style DESIGN reviewer (you have the modern-software-engineering skill; apply it).",
	"You are reviewing the SOURCE of ONE extension in the pi-dynamic-workflows monorepo (skip its tests/ dir; read them only to judge testability).",
	"Judge the design by the two competencies that matter: does it optimize for LEARNING and manage COMPLEXITY?",
	"Evaluate concretely:",
	"- COMPLEXITY: modularity, cohesion, separation of concerns, information hiding, abstraction quality, coupling (incl. to pi's SDK surface).",
	"- TESTABILITY as a design property: seams, pure logic separated from I/O, spawn/UI edges isolated.",
	"- ERROR HONESTY: are failures surfaced truthfully (no swallowed errors, no 'clean' claims for unverified states)?",
	"- CONSISTENCY: with sibling extensions' conventions and with the extension's OWN README/comments.",
	"NOTE this monorepo rule: per-extension duplication of small helpers (notify.ts, time.ts, flag parsers) is INTENTIONAL — extensions load self-contained. Do NOT recommend cross-extension DRY.",
	"GROUND every claim in file+line evidence you actually read. Do NOT edit anything.",
	"EFFICIENCY: use grep/find to navigate; read only the regions you need. Emit your report before the turn ends.",
	"",
	"OUTPUT FORMAT (Markdown, ALL sections required, keep it under ~500 lines):",
	"## VERDICT — one of: STRONG | ADEQUATE | WEAK, plus a one-sentence justification",
	"## STRENGTHS — bullet list with evidence",
	"## DESIGN CONCERNS — prioritized, most important first, each with evidence + the complexity/testability cost",
	"## RECOMMENDATIONS — smallest safe reversible steps, each framed as a testable hypothesis",
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
	const lsOut = await bash("git ls-files 'extensions/*/*.ts' 'extensions/*/README.md'");
	const files = String(lsOut?.stdout ?? lsOut ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const byExt = new Map();
	for (const file of files) {
		const ext = file.split("/")[1];
		if (!ext) continue;
		const list = byExt.get(ext) ?? [];
		list.push(file);
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
	if (extNames.length === 0) throw new Error("Scout found no extension sources to review.");
	await log("work-list", { extensions: extNames.length, files: files.length });

	// --- Substantive-output assertion + retry-on-empty (verified in #5). -------
	const forceEmpty = input?.forceEmpty === "baseline" || input?.forceEmpty === "once" ? input.forceEmpty : null;
	if (forceEmpty) await log(`TEST SEAM ACTIVE: forceEmpty=${forceEmpty} — simulating empty branch output`);

	const isSubstantive = (out) => typeof out === "string" && out.trim().length >= MIN_SUBSTANTIVE_CHARS;

	const prompt = (ext) => `${PREFIX}\n${ext} — source files:\n${byExt.get(ext).join("\n")}`;

	const reviewOnce = async (ext, { cache = true, attempt, phaseTitle }) => {
		if (forceEmpty === "baseline" && phaseTitle === "Preflight") return "";
		if (forceEmpty === "once" && attempt === 1) return "";
		const out = await agent(prompt(ext), {
			...REVIEWER,
			cache,
			label: `design-${ext}${attempt > 1 ? "-retry" : ""}`,
			phase: phaseTitle,
		});
		return typeof out === "string" ? out : (out?.output ?? out?.text ?? "");
	};

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
	await writeArtifact(`design-${baseline}.md`, canary.output);
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
	const results = [canary, ...settled.map((r, i) => r ?? { ext: rest[i], output: null, empty: true, retried: false })];

	const coverage = results.map((r) => ({
		ext: r.ext,
		status: r.empty ? "EMPTY" : "ok",
		retried: r.retried,
		chars: r.output ? r.output.length : 0,
	}));
	const empties = coverage.filter((c) => c.status === "EMPTY").map((c) => c.ext);
	for (const r of results) if (r.output && r.ext !== baseline) await writeArtifact(`design-${r.ext}.md`, r.output);
	await writeArtifact("coverage.json", coverage);
	await log("fan-out complete", { ok: results.length - empties.length, empty: empties.length, empties });

	// --- Synthesis-as-judge: empty branches are NAMED, never papered over. ------
	phase("Synthesize");
	const reviewed = results.filter((r) => !r.empty);
	const synth = [
		"You are the SYNTHESIS JUDGE for a Dave Farley-lens DESIGN review of pi extensions (reports below).",
		"Task + success criteria: produce ONE prioritized, evidence-grounded report. Discard any claim without file/line evidence. De-duplicate cross-extension themes. Respect the monorepo rule that per-extension duplication of small helpers is intentional.",
		`Coverage: ${reviewed.length}/${results.length} extensions reviewed. EMPTY/FAILED branches you MUST name as unreviewed (never infer anything about them): ${empties.length ? JSON.stringify(empties) : "none"}.`,
		"Output Markdown: `## Resumen` (verdict counts, systemic themes), `## Hallazgos priorizados` (numbered, most valuable first, with extension + evidence), `## Cobertura` (per-extension verdict table, EMPTY branches marked), `## Próximos pasos` (smallest safe reversible steps).",
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
	await writeArtifact("design-review-report.md", typeof report === "string" ? report : compact(report, 80000));

	return {
		baseline,
		reviewed: reviewed.length,
		empty: empties.length,
		empties,
		coverage,
		report,
	};
}
