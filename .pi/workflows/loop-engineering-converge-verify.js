/**
 * loop-engineering-converge-verify — bounded DISCOVERY that settles on quiet
 * rounds, then closes EACH finding with an INDEPENDENT verifier.
 *
 * The discovery-axis companion to loop-engineering-verified-refine. Same lesson
 * (docs/research/2026-06-28-loop-engineering.md; how-to in
 * docs/loop-engineering-with-extensions.md), different shape:
 *
 *   1. CONVERGE — keep fanning out finders until K consecutive rounds surface
 *      nothing new (settle-to-tolerance / "quiet rounds"), bounded by maxRounds.
 *   2. VERIFY   — require each surviving finding to pass an INDEPENDENT skeptic
 *      (guilty until proven) before it is reported. The finder never confirms
 *      its own finding.
 *
 * This is intentionally distinct from the catalog `loop-until-done` (which has
 * no per-finding independent gate) and from `adversarial-verify` (which has no
 * quiet-round discovery convergence): it FUSES both so the SAME two principles —
 * bound the loop + keep the critique signal independent — apply on the discovery
 * axis.
 *
 * Loop-engineering principles demonstrated (research §4):
 *  - Bounded termination .......... maxRounds caps the discovery loop
 *  - Convergence (quiet rounds) ... stop after `quietRounds` rounds with no new find
 *  - Actuator clamp ............... finders/quietRounds/maxRounds saturated; concurrency
 *                                   clamped to ctx.limits (and the clamp is logged)
 *  - Independent critique ......... per-finding skeptic (reviewer), not the finder
 *  - Conservative verdict ......... missing/invalid skeptic verdict counts as refuted
 *  - No silent caps ............... logs maxRounds stop, failed finders, and the clamp
 *
 * Safety: read-only tools only; no file edits. Findings, per-finding verdicts,
 * and the final report are persisted as run-dir artifacts.
 *
 * Run it (from the repo root):
 *   /workflow run loop-engineering-converge-verify {"target":"extensions/pi-loop","what":"unsafe assumptions or unbounded loops"}
 *
 * Input: { target?: string=".", what?: string, finders?=3, quietRounds?=2, maxRounds?=6 }
 */
module.exports = async function workflow(ctx, input = {}) {
	const target = String(input.target || ".").trim();
	const what = String(input.what || "correctness or safety issues").trim();
	// Actuator clamp: saturate every knob to a safe band; never trust raw input.
	const finders = Math.max(1, Math.min(8, Math.trunc(input.finders ?? 3)));
	const quietToStop = Math.max(1, Math.min(5, Math.trunc(input.quietRounds ?? 2)));
	const maxRounds = Math.max(1, Math.min(10, Math.trunc(input.maxRounds ?? 6)));
	const readOnly = ["read", "grep", "find", "ls"];

	// Robust extraction so a finder is NEVER silently dropped. The naive
	// `JSON.parse(r.output)` discarded prose-wrapped or ```json-fenced arrays — exactly
	// the "silent cap" failure this workflow is meant to avoid. We deliberately do NOT
	// put a schema on the finder: a schema turns a slow exploration agent's occasional
	// empty stream into multi-retry stalls (observed: a single finder spinning for 17m);
	// a one-shot finder + this extractor is faster and just as robust. Returns the array,
	// or undefined when the output had no parseable array (the caller logs that count).
	const extractFindings = (r) => {
		const text = String((r && r.output) || "");
		const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
		const candidate = fence ? fence[1] : text;
		const start = candidate.indexOf("[");
		const end = candidate.lastIndexOf("]");
		if (start !== -1 && end > start) {
			try {
				const arr = JSON.parse(candidate.slice(start, end + 1));
				if (Array.isArray(arr)) return arr;
			} catch {
				/* fall through to undefined */
			}
		}
		return undefined;
	};

	const seen = new Set();
	const all = [];
	let quiet = 0;
	let round = 0;

	// ---- Phase 1: discovery — bounded, converging on quiet rounds. ----
	while (quiet < quietToStop && round < maxRounds) {
		round++;
		const concurrency = Math.min(finders, ctx.limits.concurrency);
		if (concurrency < finders) {
			await ctx.log(`round ${round}: concurrency clamped ${finders} -> ${concurrency} (ctx.limits)`);
		}
		const batches = await ctx.agents(
			Array.from({ length: finders }, (_unused, i) => ({
				name: `find-r${round}-a${i + 1}`,
				prompt:
					`Search ${target} for NEW ${what} NOT already in the list below (dedupe by a short stable id). ` +
					`Use search angle #${i + 1}, different from the other finders. ` +
					`Return ONLY a JSON array of { id, title, evidence } where evidence MUST cite file:line; ` +
					`use [] if nothing new.\n\n` +
					`Already found:\n${ctx.compact([...seen], 4000)}`,
				tools: readOnly,
				includeExtensions: false, // repo-local audit: no web_search needed (faster, scoped)
				cache: false, // discovery must re-look each round, never serve a cached hit
			})),
			{ concurrency, settle: true },
		);

		const failed = batches.filter((b) => b === null).length;
		let fresh = 0;
		let unparsed = 0;
		for (const r of batches.filter(Boolean)) {
			const arr = extractFindings(r);
			if (arr === undefined) {
				unparsed++; // had output but no parseable array — surfaced below, never silently dropped
				continue;
			}
			for (const item of arr) {
				if (item && item.id && !seen.has(item.id)) {
					seen.add(item.id);
					all.push(item);
					fresh++;
				}
			}
		}
		const notes = [failed ? `${failed} failed` : "", unparsed ? `${unparsed} unparsed` : ""].filter(Boolean).join(", ");
		await ctx.log(`round ${round}: +${fresh} new (${all.length} total)${notes ? ` [${notes}]` : ""}`, { quiet });
		quiet = fresh === 0 ? quiet + 1 : 0;
	}
	if (round >= maxRounds && quiet < quietToStop) {
		// No silent caps: say we stopped on the round budget, not because we ran dry.
		await ctx.log("stopped at maxRounds (not converged)", { maxRounds, total: all.length });
	}
	await ctx.writeArtifact("findings.json", all);

	if (all.length === 0) {
		await ctx.log("converge-verify: no findings to verify");
		return { findings: 0, confirmed: 0, rounds: round, note: "no findings" };
	}

	// ---- Phase 2: INDEPENDENT per-finding verification (guilty until proven). ----
	// Bound the verification fan-out to the run's AGENT BUDGET so a large finding count
	// never blows maxAgents mid-run (a real failure observed in testing). Discovery
	// already spent `finders * round` agents; reserve 1 for synthesis. No silent caps:
	// log any deferral so the operator knows to raise maxAgents to verify everything.
	const agentBudget = Number.isFinite(ctx.limits?.maxAgents) ? ctx.limits.maxAgents : Infinity;
	const verifyBudget = agentBudget === Infinity ? all.length : Math.max(0, agentBudget - finders * round - 1);
	const toVerify = all.slice(0, verifyBudget);
	if (toVerify.length < all.length) {
		await ctx.log(
			`verifying ${toVerify.length}/${all.length} findings within agent budget (maxAgents=${agentBudget}); ` +
				`${all.length - toVerify.length} deferred — raise maxAgents to verify all`,
		);
	}
	if (toVerify.length === 0) {
		await ctx.log("converge-verify: agent budget exhausted by discovery; reporting candidates unverified");
		await ctx.writeArtifact("confirmed.json", []);
		return { findings: all.length, confirmed: 0, rounds: round, note: "agent budget exhausted before verification" };
	}

	const VERDICT = {
		type: "object",
		properties: { refuted: { type: "boolean" }, why: { type: "string" } },
		required: ["refuted"],
	};
	const verified = await ctx.agents(
		toVerify.map((f, i) => ({
			name: `verify-${i + 1}`,
			prompt:
				`You are an INDEPENDENT SKEPTIC. You did NOT find this; try to REFUTE it with evidence from ${target}. ` +
				`If you cannot confirm it with a concrete file:line, set refuted=true (guilty until proven).\n\n` +
				`FINDING:\n${ctx.compact(f, 2000)}\n\n` +
				`Return JSON { refuted: boolean, why: string }; refuted=true means the finding does NOT hold.`,
			agentType: "reviewer",
			tools: readOnly,
			includeExtensions: false, // repo-local: no web_search needed
			schema: VERDICT,
			schemaOnInvalid: "null",
		})),
		{ concurrency: Math.min(finders, ctx.limits.concurrency), settle: true },
	);

	const confirmed = [];
	for (let i = 0; i < toVerify.length; i++) {
		const v = verified[i];
		const data = v && v.data;
		// Conservative: a missing/invalid verdict counts as refuted — never a blind confirm.
		if (data && data.refuted === false) confirmed.push({ ...toVerify[i], why: data.why || "" });
	}
	await ctx.writeArtifact("confirmed.json", confirmed);
	await ctx.log(
		`converge-verify: ${confirmed.length}/${toVerify.length} verified findings survived (of ${all.length} candidates)`,
	);

	const synthesis = await ctx.agent(
		`Synthesis-as-judge. Report ONLY the independently-confirmed findings below, deduplicated and ` +
			`prioritized by severity, each with its file:line evidence. State how many candidates were refuted or deferred.\n\n` +
			`CONFIRMED:\n${ctx.compact(confirmed, 50000)}\n\nCANDIDATES: ${all.length} | VERIFIED: ${toVerify.length}`,
		{ name: "synthesis", agentType: "reviewer", tools: readOnly, includeExtensions: false },
	);
	await ctx.writeArtifact("report.md", synthesis.output || "");
	return {
		findings: all.length,
		verified: toVerify.length,
		confirmed: confirmed.length,
		rounds: round,
		report: synthesis.output || "",
	};
};
