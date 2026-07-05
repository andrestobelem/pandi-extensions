import { watch as watchDir } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, bundle, loadDefault, makeBuildDir, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

export async function buildBg({ name = "pi-bg-integration" } = {}) {
	const { url } = await buildExtension({
		name,
		src: path.join(REPO_ROOT, "extensions", "pandi-bg", "index.ts"),
		outName: "bg.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
		npx: "--no-install",
	});
	return { url };
}

export async function buildBgWithPlan({ name = "pi-bg-integration" } = {}) {
	const { outDir, aliases } = await makeBuildDir(name, {
		typebox: true,
		sdk: (dir) => sdkStub(dir),
	});
	const planUrl = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "index.ts"),
		outDir,
		outName: "plan.mjs",
		aliases,
		npx: "--no-install",
	});
	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-bg", "index.ts"),
		outDir,
		outName: "bg.mjs",
		aliases,
		npx: "--no-install",
	});
	return { outDir, url, planUrl, agentDir: path.join(outDir, "agentdir") };
}

export async function createBgTestDir(prefix) {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function setupJob(
	runsDir,
	jobId,
	{ command = "echo hi", state = "completed", updatedAt = "2026-06-25T00:00:00.000Z", log, pid, startId } = {},
) {
	const runDir = path.join(runsDir, jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "job.json"),
		JSON.stringify(
			{
				jobId,
				command,
				cwd: "/tmp/project",
				createdAt: updatedAt,
				source: "slash",
				artifactsDir: runDir,
			},
			null,
			2,
		),
	);
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify(
			{
				jobId,
				state,
				updatedAt,
				...(pid !== undefined ? { pid } : {}),
				...(startId !== undefined ? { startId } : {}),
			},
			null,
			2,
		),
	);
	if (log !== undefined) await fs.writeFile(path.join(runDir, "combined.log"), log);
	return runDir;
}

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
	return /Job en segundo plano ([A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*) iniciado\./.exec(message)?.[1];
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

export async function waitForFile(label, file, { timeoutMs = 6000 } = {}) {
	try {
		await fs.access(file);
		return file;
	} catch {
		// Fall through and wait for the producer's file-create event.
	}

	const dir = path.dirname(file);
	const base = path.basename(file);
	return await new Promise((resolve, reject) => {
		let settled = false;
		let watcher;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			watcher?.close();
			fn(value);
		};
		const checkFile = async () => {
			try {
				await fs.access(file);
				finish(resolve, file);
			} catch {
				// Not there yet; keep waiting for the next directory event or timeout.
			}
		};
		const timer = setTimeout(() => {
			finish(reject, new Error(`Timed out waiting for ${label}: ${file}`));
		}, timeoutMs);
		watcher = watchDir(dir, { persistent: false }, (_event, filename) => {
			if (filename === undefined || String(filename) === base) void checkFile();
		});
		void checkFile();
	});
}
