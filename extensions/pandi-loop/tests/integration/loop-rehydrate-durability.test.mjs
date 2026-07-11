/**
 * Suite partida de loop-caps-resume.test.mjs — ver loop-test-support.mjs.
 *
 * Ejecutar: node extensions/pandi-loop/tests/integration/<este-archivo>
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

async function rehydrateRevivesNoDoubleFire(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	seedEntries(ctx, [
		snap("revive", {
			status: "stale",
			iteration: 2,
			nextFireAt: now - 1000, // DUE: un único catch-up tick debería dispararlo
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	await tick();
	const s = latestSnapshot(entries, "revive");
	check("rehydrate: stale snapshot normalized back to 'running'", s?.status === "running", `status=${s?.status}`);
	check(
		"rehydrate: due catch-up tick delivered exactly ONE wake",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);
	check("rehydrate: catch-up advanced iteration (2 -> 3)", s?.iteration === 3, `it=${s?.iteration}`);

	// Segundo session_start (same process): el loop ya está en activeLoops con un timer live
	// -> rehydrate debe omitirlo (sin double-fire).
	const before = sentMessages.length;
	await fireEvent(handlers, "session_start", { reason: "reload" }, ctx);
	check(
		"rehydrate: second session_start does NOT double-fire (already live)",
		sentMessages.length === before,
		`delivered=${sentMessages.length}`,
	);
}

async function rehydratePausedTerminalLastWins(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	seedEntries(ctx, [
		// paused: debe quedar paused, sin wake, sin re-arm.
		snap("paused1", {
			status: "paused",
			nextFireAt: null,
			updatedAt: new Date(now - 5000).toISOString(),
		}),
		// terminal: debe ignorarse (sin recover, sin wake).
		snap("doneone", {
			status: "done",
			nextFireAt: null,
			updatedAt: new Date(now - 5000).toISOString(),
		}),
		snap("stopd", {
			status: "stopped",
			nextFireAt: null,
			updatedAt: new Date(now - 5000).toISOString(),
		}),
		// last-wins: dos entries para el MISMO loopId; el updatedAt POSTERIOR (terminal) debe ganar
		// sobre el anterior (running). El orden en JSONL es earlier-then-later.
		snap("lastwins", {
			status: "running",
			nextFireAt: now - 1000,
			updatedAt: new Date(now - 9000).toISOString(),
		}),
		snap("lastwins", {
			status: "stopped",
			nextFireAt: null,
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);

	const pausedSnap = latestSnapshot(entries, "paused1");
	check(
		"rehydrate: paused snapshot stays paused (recovered idle)",
		pausedSnap == null || pausedSnap.status === "paused",
		`status=${pausedSnap?.status}`,
	);

	// Los loops terminales no están en activeLoops y no producen snapshot nuevo desde rehydrate.
	const newDone = entries.some((e) => e.customType === "loop-state" && e.data?.loopId === "doneone");
	const newStopd = entries.some((e) => e.customType === "loop-state" && e.data?.loopId === "stopd");
	check("rehydrate: terminal 'done' snapshot is ignored (no persist)", !newDone);
	check("rehydrate: terminal 'stopped' snapshot is ignored (no persist)", !newStopd);

	// last-wins: ganó el terminal posterior, así que el loop NO fue revived -> sin catch-up wake de él.
	check(
		"rehydrate: last-wins picks the LATER (terminal) snapshot, so it is not revived",
		sentMessages.length === 0,
		`delivered=${sentMessages.length}`,
	);

	// Un segundo session_start con las direcciones invertidas: la entry POSTERIOR ahora es running ->
	// debe revivirse y disparar su due catch-up. (Prueba last-wins en ambas direcciones.)
	const ctx2 = makeCtx({ mode: "tui", hasUI: true, isIdle: true });
	const { pi: pi2, handlers: h2, entries: e2, sentMessages: sent2 } = makePi();
	const loopExtension2 = await loadDefault(url);
	loopExtension2(pi2);
	const now2 = Date.now();
	seedEntries(ctx2, [
		snap("lw2", {
			status: "stopped",
			nextFireAt: null,
			updatedAt: new Date(now2 - 9000).toISOString(),
		}),
		snap("lw2", {
			status: "running",
			nextFireAt: now2 - 1000,
			updatedAt: new Date(now2 - 1000).toISOString(),
		}),
	]);
	await fireEvent(h2, "session_start", { reason: "startup" }, ctx2);
	await tick();
	const lw2 = latestSnapshot(e2, "lw2");
	check(
		"rehydrate: last-wins (other direction) revives the LATER running snapshot",
		lw2?.status === "running",
		`status=${lw2?.status}`,
	);
	check(
		"rehydrate: revived later-running loop fires its due catch-up wake",
		sent2.length === 1,
		`delivered=${sent2.length}`,
	);
}

async function rehydrateAutonomousTrustGate(url, check) {
	// Untrusted: retirar.
	{
		const loopExtension = await loadDefault(url);
		const { pi, handlers, entries, sentMessages } = makePi();
		loopExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: false });
		const now = Date.now();
		seedEntries(ctx, [
			snap("autoloop", {
				status: "running",
				autonomous: true,
				nextFireAt: now - 1000, // estaría due, pero el trust gate debe retirarlo primero
				updatedAt: new Date(now - 1000).toISOString(),
			}),
		]);
		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		const s = latestSnapshot(entries, "autoloop");
		check(
			"autotrust: autonomous loop in an UNTRUSTED project is retired 'stopped'",
			s?.status === "stopped",
			`status=${s?.status}`,
		);
		check(
			"autotrust: retire reason mentions trust",
			/trust|confianza/i.test(s?.lastReason || ""),
			`reason=${s?.lastReason}`,
		);
		check(
			"autotrust: a retired autonomous loop fires NO wake",
			sentMessages.length === 0,
			`delivered=${sentMessages.length}`,
		);
	}
	// Trusted: revivir y disparar el due catch-up (control positivo — prueba que el retire está
	// causado por la trust revocation, no porque los loops autónomos sean unrecoverable en general).
	{
		const loopExtension = await loadDefault(url);
		const { pi, handlers, entries, sentMessages } = makePi();
		loopExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: true });
		const now = Date.now();
		seedEntries(ctx, [
			snap("autoloop2", {
				status: "running",
				autonomous: true,
				nextFireAt: now - 1000, // due -> único catch-up tick
				updatedAt: new Date(now - 1000).toISOString(),
			}),
		]);
		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		await tick();
		const s = latestSnapshot(entries, "autoloop2");
		check(
			"autotrust: autonomous loop in a TRUSTED project is revived running",
			s?.status === "running",
			`status=${s?.status}`,
		);
		check(
			"autotrust: trusted autonomous loop fires its due catch-up wake",
			sentMessages.length === 1,
			`delivered=${sentMessages.length}`,
		);
	}
}

async function rehydrateRespectsCap(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	const wall = 6 * 60 * 60 * 1000;
	seedEntries(ctx, [
		snap("dueovercap", {
			status: "stale",
			iteration: 7,
			maxWallClockMs: wall,
			startedAt: now - (wall + 60 * 1000), // sobre el deadline
			nextFireAt: now - 1000, // DUE: tienta un catch-up fire
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	const s = latestSnapshot(entries, "dueovercap");
	check(
		"rehydrate-cap: a due-but-over-budget loop is stopped 'done', not re-armed",
		s?.status === "done",
		`status=${s?.status}`,
	);
	check(
		"rehydrate-cap: it fires NO catch-up wake despite being due",
		sentMessages.length === 0,
		`delivered=${sentMessages.length}`,
	);
	check("rehydrate-cap: iteration is NOT advanced (the loop never fired)", s?.iteration === 7, `it=${s?.iteration}`);
}

async function shutdownThenStartupRehydrates(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const id = await startLoopCmd(commands, entries, "survive same-process reload", ctx);
	check(
		"shutdown-reload: loop started before shutdown",
		!!id && sentMessages.length === 1,
		`id=${id} delivered=${sentMessages.length}`,
	);

	await fireEvent(handlers, "session_shutdown", { reason: "reload" }, ctx);
	const stale = latestSnapshot(entries, id);
	check(
		"shutdown-reload: shutdown persists running loop as stale",
		stale?.status === "stale",
		`status=${stale?.status}`,
	);

	ctx.sessionManager.getEntries = () => entries;
	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	await tick();
	const revived = latestSnapshot(entries, id);
	check(
		"shutdown-reload: same-process startup rehydrates stale loop",
		revived?.status === "running",
		`status=${revived?.status}`,
	);
	check(
		"shutdown-reload: rehydrated loop delivers a catch-up wake",
		sentMessages.length === 2,
		`delivered=${sentMessages.length}`,
	);
	check(
		"shutdown-reload: rehydrated catch-up advances iteration",
		revived?.iteration === 2,
		`it=${revived?.iteration}`,
	);
}

async function rehydrateSidecarOnly(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-loop-sidecar-only-"));
	try {
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: true, cwd, sessionId: "sidecar-session" });
		loopExtension(pi);
		const now = Date.now();
		const state = snap("onlysidecar", {
			status: "running",
			iteration: 4,
			nextFireAt: now - 1000,
			ownerSessionId: "sidecar-session",
			updatedAt: new Date(now - 1000).toISOString(),
		});
		const dir = path.join(cwd, ".pi", "loops", state.loopId);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
		seedEntries(ctx, [snap("jsonl-terminal", { status: "done", updatedAt: new Date(now).toISOString() })]);

		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		await tick();
		const s = latestSnapshot(entries, "onlysidecar");
		check("rehydrate: sidecar-only loopId is recovered", s?.status === "running", `status=${s?.status}`);
		check(
			"rehydrate: sidecar-only due loop fires one catch-up wake",
			sentMessages.length === 1,
			`delivered=${sentMessages.length}`,
		);
		check("rehydrate: sidecar-only catch-up advances iteration", s?.iteration === 5, `it=${s?.iteration}`);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

async function rehydrateSkipsForeignSessionSidecar(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-loop-foreign-sidecar-"));
	try {
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: true, cwd, sessionId: "window-b" });
		loopExtension(pi);
		const now = Date.now();
		const state = snap("foreignsidecar", {
			status: "running",
			iteration: 3,
			nextFireAt: now - 1000,
			ownerSessionId: "window-a",
			updatedAt: new Date(now - 1000).toISOString(),
		});
		const dir = path.join(cwd, ".pi", "loops", state.loopId);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		await tick();
		const s = latestSnapshot(entries, "foreignsidecar");
		check("rehydrate-owner: foreign sidecar is not persisted by this window", s === undefined, `status=${s?.status}`);
		check(
			"rehydrate-owner: foreign sidecar does not wake this window",
			sentMessages.length === 0,
			`delivered=${sentMessages.length}`,
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

async function rehydrateRejectsUnsafeLoopIds(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-loop-unsafe-id-"));
	try {
		const sessionId = "unsafe-session";
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: true, cwd, sessionId });
		loopExtension(pi);
		const now = Date.now();

		const escapedFile = path.join(cwd, "escape", "state.json");
		const escapedState = snap("../../escape", {
			status: "running",
			nextFireAt: now - 1000,
			ownerSessionId: sessionId,
			updatedAt: new Date(now + 1000).toISOString(),
		});
		await fs.mkdir(path.dirname(escapedFile), { recursive: true });
		const escapedBody = `${JSON.stringify(escapedState, null, 2)}\n`;
		await fs.writeFile(escapedFile, escapedBody, "utf8");

		const sidecarDir = path.join(cwd, ".pi", "loops", "discovered-safe");
		const mismatchedSidecar = snap("../../sidecar-escape", {
			mode: "fixed",
			intervalMs: 0,
			status: "running",
			nextFireAt: now - 1000,
			ownerSessionId: sessionId,
			updatedAt: new Date(now).toISOString(),
		});
		await fs.mkdir(sidecarDir, { recursive: true });
		const mismatchedBody = `${JSON.stringify(mismatchedSidecar, null, 2)}\n`;
		await fs.writeFile(path.join(sidecarDir, "state.json"), mismatchedBody, "utf8");

		seedEntries(ctx, [
			snap("../../escape", {
				status: "stopped",
				nextFireAt: null,
				ownerSessionId: sessionId,
				updatedAt: new Date(now).toISOString(),
			}),
			snap("../retire", {
				mode: "fixed",
				intervalMs: 0,
				status: "running",
				nextFireAt: now - 1000,
				ownerSessionId: sessionId,
				updatedAt: new Date(now).toISOString(),
			}),
		]);

		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		await tick();
		await tick();

		check(
			"unsafe loopId: recovery appends no ghost or retirement state",
			entries.length === 0,
			`n=${entries.length}`,
		);
		check("unsafe loopId: recovery delivers no wake", sentMessages.length === 0, `n=${sentMessages.length}`);
		check(
			"unsafe loopId: ignored JSONL and mismatched sidecar state stay observable",
			ctx._notes.filter((note) => note.type === "warning" && /loopId|sidecar/i.test(note.msg)).length >= 3,
			JSON.stringify(ctx._notes),
		);
		check(
			"unsafe loopId: JSONL traversal never reads or overwrites outside the canonical root",
			(await fs.readFile(escapedFile, "utf8")) === escapedBody,
		);
		check(
			"unsafe loopId: invalid JSONL retirement never writes outside the canonical root",
			await fs
				.access(path.join(cwd, ".pi", "retire", "state.json"))
				.then(() => false)
				.catch(() => true),
		);
		check(
			"unsafe loopId: mismatched sidecar metadata never directs retirement outside the root",
			await fs
				.access(path.join(cwd, "sidecar-escape", "state.json"))
				.then(() => false)
				.catch(() => true),
		);
		check(
			"unsafe loopId: ignored sidecar remains at its discovered in-root location",
			(await fs.readFile(path.join(sidecarDir, "state.json"), "utf8")) === mismatchedBody,
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

async function rehydrateTerminalWinsUpdatedAtTie(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-loop-updated-at-tie-"));
	try {
		const sessionId = "tie-session";
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: true, cwd, sessionId });
		loopExtension(pi);
		const now = Date.now();
		const updatedAt = new Date(now).toISOString();
		const loopId = "updated-at-tie";
		const runningJsonl = snap(loopId, {
			status: "running",
			nextFireAt: now - 1000,
			ownerSessionId: sessionId,
			updatedAt,
		});
		const stoppedSidecar = snap(loopId, {
			status: "stopped",
			nextFireAt: null,
			ownerSessionId: sessionId,
			updatedAt,
		});
		const sidecarDir = path.join(cwd, ".pi", "loops", loopId);
		await fs.mkdir(sidecarDir, { recursive: true });
		await fs.writeFile(path.join(sidecarDir, "state.json"), `${JSON.stringify(stoppedSidecar, null, 2)}\n`, "utf8");
		seedEntries(ctx, [runningJsonl]);

		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		await tick();

		check(
			"updatedAt tie: terminal sidecar prevents JSONL running resurrection",
			sentMessages.length === 0 && entries.length === 0,
			JSON.stringify({ wakes: sentMessages.length, entries: entries.length }),
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

async function rehydrateZeroWallClockSanitized(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	const wall = 6 * 60 * 60 * 1000; // DEFAULT_MAX_WALL_CLOCK_MS
	seedEntries(ctx, [
		snap("zerocap", {
			status: "running",
			iteration: 4,
			maxIterations: 25, // no es el iteration cap
			maxWallClockMs: 0, // corrupt: deshabilitaría el wall-clock cap salvo que se sanitice
			startedAt: now - (wall + 60 * 1000), // hace 6h+1m: pasado el DEFAULT deadline
			nextFireAt: now + 60 * 60 * 1000,
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	const s = latestSnapshot(entries, "zerocap");
	check(
		"sanitize: maxWallClockMs<=0 sanitized so an over-deadline loop stops 'done'",
		s?.status === "done",
		`status=${s?.status}`,
	);
	check(
		"sanitize: stop reason mentions the wall-clock deadline",
		/wall-clock|deadline/i.test(s?.lastReason || ""),
		`reason=${s?.lastReason}`,
	);
	check(
		"sanitize: NO wake delivered for the over-deadline loop",
		sentMessages.length === 0,
		`delivered=${sentMessages.length}`,
	);
}

async function rehydrateMissingMaxIterationsSanitized(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	seedEntries(ctx, [
		snap("noiter", {
			status: "running",
			iteration: 999,
			maxIterations: undefined, // missing: deshabilitaría el iteration gate
			maxWallClockMs: 24 * 60 * 60 * 1000, // generoso: aislar el iteration cap
			startedAt: now - 1000,
			nextFireAt: now - 1000, // DUE -> rehydrate arma un catch-up fireWake de 0ms
			updatedAt: new Date(now).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	await tick();
	const s = latestSnapshot(entries, "noiter");
	check(
		"sanitize: missing maxIterations sanitized so a DUE over-cap loop stops 'done'",
		s?.status === "done",
		`status=${s?.status}`,
	);
	check(
		"sanitize: stop reason names maxIterations",
		/maxIterations/i.test(s?.lastReason || ""),
		`reason=${s?.lastReason}`,
	);
	check("sanitize: capped loop delivered NO new wake", sentMessages.length === 0, `delivered=${sentMessages.length}`);
}

async function rehydrateRejectsInvalidFixedSchedules(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });
	const now = Date.now();
	const invalidIntervals = [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1000];
	seedEntries(
		ctx,
		invalidIntervals.map((intervalMs, index) =>
			snap(`invalid-fixed-${index}`, {
				mode: "fixed",
				intervalMs,
				status: "running",
				nextFireAt: now - 1000,
				updatedAt: new Date(now + index).toISOString(),
			}),
		),
	);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	await tick();
	for (let index = 0; index < invalidIntervals.length; index++) {
		const state = latestSnapshot(entries, `invalid-fixed-${index}`);
		check(
			`invalid fixed ${String(invalidIntervals[index])}: snapshot is retired observably`,
			state?.status === "stopped" && /interval|schedule|fixed/i.test(state?.lastReason || ""),
			JSON.stringify(state),
		);
		check(
			`invalid fixed ${String(invalidIntervals[index])}: retired state is not an impossible fixed schedule`,
			state?.mode === "dynamic" && state?.intervalMs === undefined,
			JSON.stringify(state),
		);
	}
	check(
		"invalid fixed: no snapshot rearms or fires a wake",
		sentMessages.length === 0,
		`delivered=${sentMessages.length}`,
	);
	const entriesBeforeAgentEnd = entries.length;
	await fireEvent(handlers, "agent_end", {}, ctx);
	check(
		"invalid fixed: retired snapshots leave no active ghost on agent_end",
		entries.length === entriesBeforeAgentEnd && sentMessages.length === 0,
	);
}

async function rehydrateLegacyMissingModeAsDynamic(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });
	const now = Date.now();
	const { mode: _legacyMode, ...legacy } = snap("legacy-no-mode", {
		intervalMs: 300000,
		status: "stale",
		nextFireAt: now - 1000,
		updatedAt: new Date(now).toISOString(),
	});
	seedEntries(ctx, [legacy]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	await tick();
	const state = latestSnapshot(entries, "legacy-no-mode");
	check("legacy schedule: missing mode rehydrates as dynamic", state?.mode === "dynamic", JSON.stringify(state));
	check("legacy schedule: stray interval is not retained", state?.intervalMs === undefined, JSON.stringify(state));
	check(
		"legacy schedule: due dynamic snapshot still fires once",
		sentMessages.length === 1,
		`delivered=${sentMessages.length}`,
	);
}

async function rehydrateRetiresInvalidFixedSidecar(url, check) {
	const loopExtension = await loadDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-loop-invalid-fixed-sidecar-"));
	try {
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: true, cwd, sessionId: "sidecar-owner" });
		loopExtension(pi);
		const state = snap("invalid-fixed-sidecar", {
			mode: "fixed",
			intervalMs: 0,
			status: "running",
			nextFireAt: Date.now() - 1000,
			ownerSessionId: "sidecar-owner",
			updatedAt: new Date().toISOString(),
		});
		const dir = path.join(cwd, ".pi", "loops", state.loopId);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		await tick();
		const retired = latestSnapshot(entries, state.loopId);
		check(
			"invalid fixed sidecar: parser retires it with an observable reason",
			retired?.status === "stopped" && /interval|schedule|fixed/i.test(retired?.lastReason || ""),
			JSON.stringify(retired),
		);
		check(
			"invalid fixed sidecar: no wake is delivered",
			sentMessages.length === 0,
			`delivered=${sentMessages.length}`,
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

async function main() {
	await runLoopScenarios({
		name: "pi-loop-loop-rehydrate-durability",
		scenarios: [
			rehydrateRevivesNoDoubleFire,
			rehydratePausedTerminalLastWins,
			rehydrateAutonomousTrustGate,
			rehydrateRespectsCap,
			shutdownThenStartupRehydrates,
			rehydrateSidecarOnly,
			rehydrateSkipsForeignSessionSidecar,
			rehydrateRejectsUnsafeLoopIds,
			rehydrateTerminalWinsUpdatedAtTie,
			rehydrateZeroWallClockSanitized,
			rehydrateMissingMaxIterationsSanitized,
			rehydrateRejectsInvalidFixedSchedules,
			rehydrateLegacyMissingModeAsDynamic,
			rehydrateRetiresInvalidFixedSidecar,
		],
	});
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
