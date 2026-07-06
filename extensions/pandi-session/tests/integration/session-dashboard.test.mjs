#!/usr/bin/env node
/**
 * Behavioral contract for the standalone Pandi session dashboard component.
 *
 * It is intentionally a focused sessions UI, not a tab inside the workflow
 * dashboard. The component renders session rows/details and emits semantic
 * actions; orchestration handles switching and cleanup.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

async function buildDashboard() {
	return await buildExtension({
		name: "pandi-session-dashboard",
		src: path.join(REPO_ROOT, "extensions", "pandi-session", "session-dashboard.ts"),
		outName: "session-dashboard.mjs",
		stubs: { tui: true },
	});
}

const theme = {
	fg: (_c, value) => value,
	bg: (_c, value) => value,
	bold: (value) => value,
};

function mkSession(id, overrides = {}) {
	const now = new Date().toISOString();
	return {
		id,
		pid: overrides.pid ?? 123,
		mode: overrides.mode ?? "tui",
		cwd: overrides.cwd ?? "/project",
		startedAt: overrides.startedAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
		file: overrides.file ?? `/project/.pi/pandi-session/live/${id}.json`,
		live: overrides.live ?? true,
		current: overrides.current ?? false,
		ageMs: overrides.ageMs ?? 50,
		sessionId: overrides.sessionId ?? `${id}-sid`,
		sessionFile: overrides.sessionFile ?? `/project/.pi/sessions/${id}.jsonl`,
		sessionName: overrides.sessionName ?? `Session ${id}`,
		trusted: overrides.trusted ?? true,
		idle: overrides.idle ?? true,
		...(overrides.staleReason ? { staleReason: overrides.staleReason } : {}),
	};
}

async function main() {
	const { outDir, url } = await buildDashboard();
	try {
		const { PandiSessionDashboard } = await import(url);
		let renders = 0;
		let captured = null;
		const component = new PandiSessionDashboard(
			[mkSession("current", { current: true }), mkSession("other", { live: false, staleReason: "pid exited" })],
			theme,
			() => {
				renders += 1;
			},
			(result) => {
				captured = result;
			},
		);

		const text = component.render(120).join("\n");
		check("dashboard header names Pandi sessions", text.includes("Pandi sessions"), text);
		check("dashboard renders live/stale counts", text.includes("live:1") && text.includes("stale:1"), text);
		check(
			"dashboard renders selected session detail",
			text.includes("Selected Pandi session") && text.includes("current-sid"),
			text,
		);

		component.handleInput("down");
		check("down key requests rerender", renders > 0, String(renders));
		component.handleInput("enter");
		check(
			"Enter emits switchSession for selected row",
			captured?.type === "switchSession" && captured.session?.id === "other",
			JSON.stringify(captured),
		);

		captured = null;
		component.setSessions([mkSession("fresh"), mkSession("other", { live: true })]);
		component.handleInput("enter");
		check(
			"setSessions preserves selected row by session id",
			captured?.type === "switchSession" && captured.session?.id === "other",
			JSON.stringify(captured),
		);
		component.markRefreshError("collector failed noisily");
		check(
			"refresh errors are visible in the dashboard",
			component.render(120).join("\n").includes("refresh warning"),
		);
		component.markRefreshOk();
		check("refresh ok clears dashboard warning", !component.render(120).join("\n").includes("refresh warning"));

		captured = null;
		component.handleInput("C");
		check("C emits cleanup action", captured?.type === "cleanup", JSON.stringify(captured));

		captured = "not-null";
		component.handleInput("q");
		check("q closes with null", captured === null, JSON.stringify(captured));
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	if (counts.failed) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
