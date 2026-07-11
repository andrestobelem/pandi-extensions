#!/usr/bin/env node

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createChecker, loadModule, STUB_SOURCES } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

function makeTheme() {
	const id = (text) => text;
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: id,
		italic: id,
		underline: id,
		inverse: id,
		strikethrough: id,
	};
}

async function waitForRender(component, predicate) {
	let rendered = "";
	for (let attempt = 0; attempt < 50; attempt++) {
		rendered = component.render(120).join("\n");
		if (predicate(rendered)) return { ok: true, rendered };
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return { ok: false, rendered };
}

async function writeAgentEvent(runDir, output) {
	await fs.writeFile(
		path.join(runDir, "events.jsonl"),
		`${JSON.stringify({
			type: "agent",
			id: 1,
			name: "scout",
			state: "completed",
			output,
			promptAvailable: false,
		})}\n`,
		"utf8",
	);
}

async function main() {
	const throwingTuiStub = STUB_SOURCES.tui.replace(
		'export class Markdown { constructor(text) { this.text = String(text == null ? "" : text); }',
		'export class Markdown { constructor(text) { this.text = String(text == null ? "" : text); if (this.text.includes("FAIL_REFRESH")) throw new Error("synthetic refresh failure"); }',
	);
	check("test stub injects the refresh failure", throwingTuiStub !== STUB_SOURCES.tui);

	const { url } = await buildDwfModule({
		name: "pi-dwf-agent-refresh-recovery",
		relPath: "tui/agent-view.ts",
		outName: "agent-view.mjs",
		stubs: { tui: throwingTuiStub },
	});
	const { showLiveAgentView } = await loadModule(url);

	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-agent-refresh-"));
	const runDir = path.join(project, ".pi", "workflows", "runs", "refresh-recovery");
	await fs.mkdir(runDir, { recursive: true });
	await writeAgentEvent(runDir, "STABLE_OUTPUT");

	const run = {
		workflow: "refresh-recovery",
		scope: "project",
		runId: "refresh-recovery",
		runDir,
		state: "completed",
		ok: true,
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:00:01.000Z",
		elapsedMs: 1000,
		agentCount: 1,
		logs: [],
	};
	const agent = { id: 1, name: "scout", state: "completed", output: "STABLE_OUTPUT", promptAvailable: false };
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: project,
		isProjectTrusted: () => true,
		ui: {
			theme: makeTheme(),
			notify: () => {},
			custom: async (factory) => {
				let doneValue;
				const tui = { terminal: { rows: 36, columns: 120 }, requestRender: () => {} };
				const component = factory(tui, ctx.ui.theme, {}, (value) => {
					doneValue = value;
				});

				component.handleInput("4");
				const stable = await waitForRender(component, (rendered) => /STABLE_OUTPUT/.test(rendered));
				check("initial refresh renders stable output", stable.ok, stable.rendered);

				await writeAgentEvent(runDir, "FAIL_REFRESH");
				component.handleInput("1");
				await new Promise((resolve) => setTimeout(resolve, 30));
				const failed = component.render(120).join("\n");
				check(
					"failed refresh exposes a recoverable status",
					/falló el refresh/.test(failed) && /synthetic refresh failure/.test(failed),
					failed,
				);

				await writeAgentEvent(runDir, "RECOVERED_OUTPUT");
				component.handleInput("4");
				const preserved = component.render(120).join("\n");
				check("failed refresh preserves the previous tab content", /STABLE_OUTPUT/.test(preserved), preserved);

				const recovered = await waitForRender(component, (rendered) => /RECOVERED_OUTPUT/.test(rendered));
				check("refresh state is released and a later retry succeeds", recovered.ok, recovered.rendered);
				check(
					"successful retry clears the failure status",
					!/falló el refresh/.test(recovered.rendered),
					recovered.rendered,
				);
				component.handleInput("q");
				return doneValue;
			},
		},
	};

	try {
		await showLiveAgentView(ctx, run, agent);
		await new Promise((resolve) => setTimeout(resolve, 20));
		check(
			"void-triggered refresh failures do not emit unhandledRejection",
			unhandled.length === 0,
			String(unhandled[0]),
		);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}

	if (counts.failed > 0) {
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
