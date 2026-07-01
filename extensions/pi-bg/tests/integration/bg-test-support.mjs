import * as fs from "node:fs/promises";
import { loadDefault } from "../../../shared/test/harness.mjs";

export function shellQuote(value) {
	return JSON.stringify(value);
}

export function makePi() {
	const commands = new Map();
	const tools = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (def) => tools.set(def.name, def),
			on: () => {},
			appendEntry: () => {},
			sendUserMessage: () => {},
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		},
		commands,
		tools,
	};
}

export function makeCtx({ cwd, trusted = true, mode = "tui", hasUI = true } = {}) {
	const notes = [];
	const ctx = {
		mode,
		hasUI,
		cwd,
		isProjectTrusted: () => trusted,
		isIdle: () => true,
		ui: {
			notify: (msg, type) => notes.push({ msg, type }),
			setStatus: () => {},
			theme: { fg: (_c, s) => s },
		},
		sessionManager: { getEntries: () => [] },
	};
	ctx._notes = notes;
	return ctx;
}

export async function loadExtension(url) {
	const extension = await loadDefault(url);
	const { pi, commands, tools } = makePi();
	extension(pi);
	return { commands, tools };
}

export function parseJobId(message) {
	return /Started background job ([A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*)\./.exec(message)?.[1];
}

export async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function waitFor(label, fn, { timeoutMs = 6000, intervalMs = 25 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (last) return last;
		} catch (err) {
			last = err;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`Timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}
