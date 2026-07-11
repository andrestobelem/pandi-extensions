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
	startLoopCmd,
} from "./loop-test-support.mjs";

async function pauseResume(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	// Iniciar un loop DYNAMIC. El primer wake dispara (iteration 1). agent_end re-arms un timer real
	// (safety-net delay) para que haya un nextFireAt live que preservar durante pause.
	const id = await startLoopCmd(commands, entries, "pausable work", ctx);
	await fireEvent(handlers, "agent_end", {}, ctx);
	const armed = latestSnapshot(entries, id);
	check(
		"pause: loop is running with a future nextFireAt before pause",
		armed?.status === "running" && typeof armed?.nextFireAt === "number" && armed.nextFireAt > Date.now(),
		`status=${armed?.status} next=${armed?.nextFireAt}`,
	);

	const sentBeforePause = sentMessages.length;
	await commands.get("loop").handler(`pause ${id}`, ctx);
	const paused = latestSnapshot(entries, id);
	check("pause: status persisted as 'paused'", paused?.status === "paused", `status=${paused?.status}`);
	check(
		"pause: pausing does NOT re-inject a wake",
		sentMessages.length === sentBeforePause,
		`delivered=${sentMessages.length}`,
	);
	check(
		"pause: iteration is preserved across pause (not reset)",
		paused?.iteration === armed?.iteration,
		`it=${paused?.iteration} vs ${armed?.iteration}`,
	);

	// Un loop paused NO debe disparar aunque su timer se haya armado antes: pause lo limpió.
	// Pulsar agent_end (la safety net solo re-arms loops RUNNING): sin wake nuevo, sigue paused.
	const sentBeforeIdle = sentMessages.length;
	await fireEvent(handlers, "agent_end", {}, ctx);
	const stillPaused = latestSnapshot(entries, id);
	check(
		"pause: paused loop is NOT re-armed by the agent_end safety net",
		stillPaused?.status === "paused",
		`status=${stillPaused?.status}`,
	);
	check(
		"pause: paused loop delivers no wake on agent_end",
		sentMessages.length === sentBeforeIdle,
		`delivered=${sentMessages.length}`,
	);

	// Resume: status vuelve a running y se re-arma un nextFireAt futuro fresco.
	await commands.get("loop").handler(`resume ${id}`, ctx);
	const resumed = latestSnapshot(entries, id);
	check("resume: status back to 'running'", resumed?.status === "running", `status=${resumed?.status}`);
	check(
		"resume: re-arms a future nextFireAt",
		typeof resumed?.nextFireAt === "number" && resumed.nextFireAt > Date.now(),
		`next=${resumed?.nextFireAt}`,
	);
	check(
		"resume: reason notes it was resumed by the user",
		/resume|reanudado/i.test(resumed?.lastReason || ""),
		`reason=${resumed?.lastReason}`,
	);

	// Guards no-op: resume de un loop ya running, pause de un loop inexistente.
	const beforeNoop = entries.length;
	await commands.get("loop").handler(`resume ${id}`, ctx); // ya running
	const afterResumeNoop = latestSnapshot(entries, id);
	check(
		"resume: resuming an already-running loop is a no-op (stays running)",
		afterResumeNoop?.status === "running",
		`status=${afterResumeNoop?.status}`,
	);
	check(
		"resume: no-op on running loop persists no spurious 'paused' snapshot",
		!entries
			.slice(beforeNoop)
			.some((e) => e.customType === "loop-state" && e.data?.loopId === id && e.data?.status === "paused"),
	);
}

async function pauseDropsQueuedWake(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const idA = await startLoopCmd(commands, entries, "loop A holds turn", ctx);
	check(
		"pausequeue: A delivered its wake (holds the in-flight turn)",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);
	const idB = await startLoopCmd(commands, entries, "loop B queues behind A", ctx);
	check(
		"pausequeue: B's wake is QUEUED, not delivered (one turn at a time)",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);

	// Pause B mientras su wake sigue en la FIFO. La entry encolada debe descartarse para que
	// nunca re-inject cuando cierre el turno de A.
	await commands.get("loop").handler(`pause ${idB}`, ctx);
	const bPaused = latestSnapshot(entries, idB);
	check("pausequeue: B is paused", bPaused?.status === "paused", `status=${bPaused?.status}`);

	// Cerrar el turno de A: la queue drena. B fue descartado, así que NO se entrega wake nuevo.
	await fireEvent(handlers, "agent_end", {}, ctx);
	check(
		"pausequeue: paused B does NOT fire from the queue after agent_end",
		!sentMessages.some((m) => /loop B queues behind A/.test(m.content || "")),
		`delivered=${sentMessages.length}`,
	);
	void idA;
}
async function main() {
	await runLoopScenarios({
		name: "pi-loop-loop-pause-resume",
		scenarios: [pauseResume, pauseDropsQueuedWake],
	});
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
