#!/usr/bin/env node
/**
 * workflow-final-handoff — pins #78: when a background workflow reaches a
 * terminal state, Pi writes the final run report HTML, opens it best-effort, and
 * points both the notification and wake prompt at that first-class artifact.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

const WORKFLOW = String.raw`
export const meta = {
	name: "final-handoff",
	description: "final HTML handoff probe",
	basedOn: [{ name: "fan-out-and-synthesize", role: "scatter-gather base" }],
};
phase("Gather");
const worker = await agent("Summarize in Markdown", {
	name: "handoff-worker",
	model: "anthropic/claude-sonnet-5",
	effort: "medium",
	tools: ["read"],
	skills: ["karpathy-guidelines"],
});
return "## Final synthesis\n\n**done** from " + worker.output;
`;

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-final-handoff",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
}

function makePi({ execFails = false } = {}) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const userMessages = [];
	const execCalls = [];
	return {
		pi: {
			registerTool: (def) => tools.set(def.name, def),
			registerCommand: (name, def) => commands.set(name, def),
			registerShortcut: () => {},
			on: (event, handler) => {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event).push(handler);
			},
			appendEntry: () => {},
			sendUserMessage: (message, options) => userMessages.push({ message, options }),
			getThinkingLevel: () => undefined,
			getActiveTools: () => [],
			getAllTools: () => [...tools.values()],
			setActiveTools: () => {},
			exec: async (cmd, args, opts) => {
				execCalls.push({ cmd, args, opts });
				if (execFails) throw new Error("simulated open failure");
				return { code: 0, killed: false, stdout: "", stderr: "" };
			},
		},
		tools,
		commands,
		handlers,
		userMessages,
		execCalls,
	};
}

function makeCtx(cwd) {
	const notifications = [];
	const statuses = [];
	const widgets = [];
	return {
		ctx: {
			mode: "tui",
			hasUI: true,
			cwd,
			isIdle: () => true,
			isProjectTrusted: () => true,
			getContextUsage: () => undefined,
			ui: {
				theme: { fg: (_color, value) => value, bold: (value) => value },
				notify: (message, type) => notifications.push({ message, type }),
				setStatus: (key, value) => statuses.push({ key, value }),
				setWidget: (key, value, options) => widgets.push({ key, value, options }),
				confirm: async () => true,
				select: async () => undefined,
				editor: async (_title, initial = "") => initial,
				custom: async () => undefined,
				getEditorComponent: () => undefined,
				setEditorComponent: () => {},
			},
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [],
				getSessionId: () => "final-handoff-session",
				getSessionFile: () => path.join(cwd, "final-handoff.jsonl"),
				getSessionName: () => "final-handoff",
			},
		},
		notifications,
		statuses,
		widgets,
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-final-handoff-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "final-handoff.js"), `${WORKFLOW}\n`, "utf8");
	const fakePi = path.join(project, "fake-pi.mjs");
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node\n` +
			`process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "## Worker result\\n\\n- item" }] } }) + "\\n");\n` +
			`process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## Worker result\\n\\n- item" }], usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } } } }) + "\\n");\n`,
		"utf8",
	);
	await fs.chmod(fakePi, 0o755);
	return { project, fakePi };
}

async function waitFor(label, fn, timeoutMs = 8000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeoutMs) {
		try {
			last = await fn();
			if (last) return last;
		} catch (err) {
			last = err instanceof Error ? err.message : String(err);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function joinedMessages(entries) {
	return entries.map((entry) => entry.message).join("\n---\n");
}

function handoffText(ctxState, piState) {
	return {
		notificationText: joinedMessages(ctxState.notifications),
		wakeText: joinedMessages(piState.userMessages),
	};
}

function reportWasOpened(piState, reportPath) {
	return piState.execCalls.some((call) => call.args?.includes(reportPath));
}

async function waitForReportHtml(label, reportPath) {
	return await waitFor(label, async () => {
		const html = await fs.readFile(reportPath, "utf8").catch(() => undefined);
		return html?.includes("</html>") ? html : undefined;
	});
}

async function waitForReportHandoff(label, ctxState, piState, reportPath) {
	await waitFor(label, () => {
		const { notificationText, wakeText } = handoffText(ctxState, piState);
		return (
			notificationText.includes(reportPath) && wakeText.includes(reportPath) && reportWasOpened(piState, reportPath)
		);
	});
}

async function main() {
	const oldCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	try {
		const { url } = await buildExtension();
		const mod = await import(url);
		const { project, fakePi } = await makeProject();
		process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;
		const piState = makePi();
		const ctxState = makeCtx(project);
		(mod.default.activate ?? mod.default)(piState.pi, ctxState.ctx);
		const tool = piState.tools.get("dynamic_workflow");
		check("dynamic_workflow tool registered", !!tool);

		const start = await tool.execute(
			"tc-final-handoff",
			{ action: "start", name: "final-handoff", timeoutMs: 30_000, agentTimeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			ctxState.ctx,
		);
		const status = start?.details?.status;
		check("background start returns running status", status?.state === "running", JSON.stringify(status));
		const reportPath = path.join(status.runDir, "report.html");

		await waitForReportHtml("final report", reportPath);
		await waitForReportHandoff("final handoff", ctxState, piState, reportPath);
		const html = await fs.readFile(reportPath, "utf8");
		const { notificationText, wakeText } = handoffText(ctxState, piState);

		check("final report is non-empty", html.length > 1000, String(html.length));
		check(
			"final report is a run report, not static preview",
			html.includes("workflow run report") && !html.includes("preview estático"),
		);
		check(
			"final report includes real final output",
			html.includes("Final synthesis") && html.includes("Worker result"),
		);
		check(
			"final output Markdown renders",
			/<h2[^>]*>Final synthesis<\/h2>/.test(html) && html.includes("<strong>done</strong>"),
		);
		check(
			"agent provenance includes model and effort",
			html.includes("anthropic/claude-sonnet-5") && html.includes("effort: medium"),
		);
		check(
			"agent provenance includes tools and skills",
			html.includes("tools") && html.includes("read") && html.includes("karpathy-guidelines"),
		);
		check(
			"workflow provenance includes based-on metadata",
			html.includes("fan-out-and-synthesize") && html.includes("scatter-gather base"),
		);
		check("completion notification points to report.html", notificationText.includes(reportPath), notificationText);
		check("wake prompt points to report.html", wakeText.includes(reportPath), wakeText);
		check(
			"final report is opened best-effort",
			reportWasOpened(piState, reportPath),
			JSON.stringify(piState.execCalls),
		);

		const fallback = await makeProject();
		process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fallback.fakePi;
		const fallbackPi = makePi({ execFails: true });
		const fallbackCtx = makeCtx(fallback.project);
		(mod.default.activate ?? mod.default)(fallbackPi.pi, fallbackCtx.ctx);
		const fallbackTool = fallbackPi.tools.get("dynamic_workflow");
		const fallbackStart = await fallbackTool.execute(
			"tc-final-handoff-open-fails",
			{ action: "start", name: "final-handoff", timeoutMs: 30_000, agentTimeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			fallbackCtx.ctx,
		);
		const fallbackStatus = fallbackStart?.details?.status;
		const fallbackReportPath = path.join(fallbackStatus.runDir, "report.html");
		await waitForReportHtml("final report after open failure", fallbackReportPath);
		await waitForReportHandoff("final handoff after open failure", fallbackCtx, fallbackPi, fallbackReportPath);
		const fallbackResult = JSON.parse(await fs.readFile(path.join(fallbackStatus.runDir, "result.json"), "utf8"));
		const { notificationText: fallbackNotificationText, wakeText: fallbackWakeText } = handoffText(
			fallbackCtx,
			fallbackPi,
		);
		check(
			"open failure keeps workflow completed",
			fallbackResult.state === "completed",
			JSON.stringify(fallbackResult),
		);
		check(
			"open failure still leaves report handoff",
			fallbackNotificationText.includes(fallbackReportPath),
			fallbackNotificationText,
		);
		check(
			"open failure still wakes with report path",
			fallbackWakeText.includes(fallbackReportPath),
			fallbackWakeText,
		);
		check(
			"open failure was attempted but swallowed",
			reportWasOpened(fallbackPi, fallbackReportPath),
			JSON.stringify(fallbackPi.execCalls),
		);
	} finally {
		if (oldCommand === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = oldCommand;
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
