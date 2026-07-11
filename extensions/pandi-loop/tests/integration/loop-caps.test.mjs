/**
 * Suite partida de loop-caps-resume.test.mjs — ver loop-test-support.mjs.
 *
 * Ejecutar: node extensions/pandi-loop/tests/integration/<este-archivo>
 */

import {
	fireEvent,
	latestSnapshot,
	loadDefault,
	makeCtx,
	makePi,
	runLoopScenarios,
	seedEntries,
	snap,
	startLoopCmd,
	tick,
} from "./loop-test-support.mjs";

async function maxIterationsCap(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const id = await startLoopCmd(commands, entries, "burn iterations", ctx);
	check(
		"maxIter: loop started, first wake delivered (iteration 1)",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);
	const s1 = latestSnapshot(entries, id);
	check("maxIter: iteration advanced to 1 on first wake", s1?.iteration === 1, `it=${s1?.iteration}`);
	check("maxIter: default maxIterations is 25", s1?.maxIterations === 25, `max=${s1?.maxIterations}`);

	// Manejar el iteration cap vía su gate REAL (fireWake). Sembrar un snapshot running en el
	// cap Y due, para que rehydrate arme un catch-up tick de 0ms; fireWake entonces pega en el guard
	// maxIterations y lo detiene en "done" en vez de disparar una iteration (capped).
	const ctx2 = makeCtx({ mode: "tui", hasUI: true, isIdle: true });
	const { pi: pi2, handlers: h2, entries: e2, sentMessages: sent2 } = makePi();
	const loopExtension2 = await loadDefault(url);
	loopExtension2(pi2);
	const now = Date.now();
	seedEntries(ctx2, [
		snap("atcap", {
			status: "running",
			iteration: 3,
			maxIterations: 3, // ya EN el cap
			maxWallClockMs: 24 * 60 * 60 * 1000, // generoso: aislar el iteration cap
			startedAt: now - 1000,
			nextFireAt: now - 1000, // DUE -> rehydrate arma un catch-up tick de 0ms (fireWake)
			updatedAt: new Date(now).toISOString(),
		}),
	]);
	await fireEvent(h2, "session_start", { reason: "startup" }, ctx2);
	await tick(); // dejar correr el catch-up fireWake de 0ms
	const cap = latestSnapshot(e2, "atcap");
	check(
		"maxIter: a DUE loop AT maxIterations is stopped 'done' by the fire gate",
		cap?.status === "done",
		`status=${cap?.status}`,
	);
	check(
		"maxIter: stop reason names maxIterations",
		/maxIterations/i.test(cap?.lastReason || ""),
		`reason=${cap?.lastReason}`,
	);
	check(
		"maxIter: capped loop delivered NO new wake (iteration not advanced)",
		sent2.length === 0 && cap?.iteration === 3,
		`delivered=${sent2.length} it=${cap?.iteration}`,
	);
}

async function wallClockCap(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	const wall = 6 * 60 * 60 * 1000; // budget de 6h
	seedEntries(ctx, [
		snap("overtime", {
			status: "running",
			iteration: 4,
			maxIterations: 25, // NO es el iteration cap — aislar el wall-clock cap
			maxWallClockMs: wall,
			startedAt: now - (wall + 60 * 1000), // hace 6h+1m: pasado el deadline
			nextFireAt: now + 60 * 60 * 1000, // futuro: el catch-up propio de rehydrate no dispara
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	const s = latestSnapshot(entries, "overtime");
	check(
		"wallclock: loop past its deadline is stopped 'done' on rehydrate",
		s?.status === "done",
		`status=${s?.status}`,
	);
	check(
		"wallclock: stop reason mentions the wall-clock deadline",
		/wall-clock|deadline/i.test(s?.lastReason || ""),
		`reason=${s?.lastReason}`,
	);
	check(
		"wallclock: NOT mislabeled as an iteration cap",
		!/maxIterations/i.test(s?.lastReason || ""),
		`reason=${s?.lastReason}`,
	);
	check(
		"wallclock: NO wake delivered for an over-deadline loop",
		sentMessages.length === 0,
		`delivered=${sentMessages.length}`,
	);
}

async function contextPercentCap(url, check) {
	// Sobre el cap: un loop running debe detenerse en "done" en agent_end.
	{
		const loopExtension = await loadDefault(url);
		const { pi, commands, handlers, entries, sentMessages } = makePi();
		loopExtension(pi);
		let pct = 10; // sano al inicio
		const ctx = makeCtx({
			mode: "tui",
			hasUI: true,
			isIdle: true,
			usage: () => ({ percent: pct }),
		});

		const id = await startLoopCmd(commands, entries, "fill the context", ctx);
		check("ctxcap: loop started while context is low", sentMessages.length === 1, `delivered=${sentMessages.length}`);

		// Primer agent_end mientras sigue sano: debe re-arm, NO detener.
		await fireEvent(handlers, "agent_end", {}, ctx);
		const healthy = latestSnapshot(entries, id);
		check(
			"ctxcap: under the cap (10% < 90%), loop keeps running",
			healthy?.status === "running",
			`status=${healthy?.status}`,
		);

		// Ahora el context supera el cap; el siguiente agent_end debe detenerlo en "done".
		pct = 95;
		await fireEvent(handlers, "agent_end", {}, ctx);
		const over = latestSnapshot(entries, id);
		check(
			"ctxcap: over the cap (95% >= 90%), loop is stopped 'done'",
			over?.status === "done",
			`status=${over?.status}`,
		);
		check(
			"ctxcap: stop reason mentions the context budget",
			/context budget|%/i.test(over?.lastReason || ""),
			`reason=${over?.lastReason}`,
		);
	}
	// Control negativo: usage unavailable (undefined) o percent null NUNCA debe detener el loop
	// (best-effort: una señal ausente no es un cap hit).
	{
		const loopExtension = await loadDefault(url);
		const { pi, commands, handlers, entries } = makePi();
		loopExtension(pi);
		const ctx = makeCtx({
			mode: "tui",
			hasUI: true,
			isIdle: true,
			usage: () => ({ percent: null }),
		});
		const id = await startLoopCmd(commands, entries, "unknown context", ctx);
		await fireEvent(handlers, "agent_end", {}, ctx);
		const s = latestSnapshot(entries, id);
		check(
			"ctxcap: null context percent is NOT a cap hit (loop stays running)",
			s?.status === "running",
			`status=${s?.status}`,
		);
	}
}

async function concurrentLoopCap(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, entries } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const CAP = 20; // refleja MAX_CONCURRENT_LOOPS en constants.ts
	const started = [];
	for (let i = 0; i < CAP; i++) {
		const id = await startLoopCmd(commands, entries, `cap task ${i}`, ctx);
		if (id) started.push(id);
	}
	check(`concurrency: started ${CAP} loops up to the cap`, started.length === CAP, `started=${started.length}`);

	const before = ctx._notes.length;
	const overflow = await startLoopCmd(commands, entries, "one too many", ctx);
	check("concurrency: the (cap+1)th /loop is REFUSED (no new loop created)", overflow === undefined, `id=${overflow}`);
	const refused = ctx._notes
		.slice(before)
		.some(
			(n) =>
				(n.type === "error" || n.type === "warning") && /concurrent|max|cap|limit|too many|demasiados/i.test(n.msg),
		);
	check(
		"concurrency: the refusal is surfaced to the user",
		refused,
		`notes=${JSON.stringify(ctx._notes.slice(before))}`,
	);
}
async function main() {
	await runLoopScenarios({
		name: "pi-loop-loop-caps",
		scenarios: [maxIterationsCap, wallClockCap, contextPercentCap, concurrentLoopCap],
	});
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
