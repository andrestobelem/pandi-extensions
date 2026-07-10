import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Ajv from "ajv";

import { buildCursorCommand, invokeCursor, resolveCursorModel } from "./cursor-agent.mjs";
import { transformWorkflowCode } from "./transform.mjs";

const require = createRequire(import.meta.url);
const MAX_COLLECTION = 4096;
const DEFAULT_TIMEOUT_MS = 120_000;

function slug(value) {
	return (
		String(value)
			.toLowerCase()
			.replace(/[^a-z0-9._/-]+/g, "-")
			.replace(/(^|\/)\.\.(?=\/|$)/g, "")
			.replace(/^[-/]+|[-/]+$/g, "")
			.slice(0, 80) || "workflow"
	);
}

function stable(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
		.join(",")}}`;
}

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

// Un workflow corre en otro realm de vm; normalizamos su retorno antes de exponerlo al host/journal.
function portableValue(value) {
	return value !== null && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
}

function inside(root, candidate) {
	const resolved = path.resolve(root, candidate);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Path escapes the workflow workspace: ${candidate}`);
	}
	return resolved;
}

async function writeJson(file, value) {
	await fs.writeFile(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

async function readJson(file, fallback) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return fallback;
		throw error;
	}
}

function makeSemaphore(limit) {
	let active = 0;
	const waiting = [];
	const acquire = async () => {
		if (active < limit) {
			active++;
			return;
		}
		await new Promise((resolve) => waiting.push(resolve));
		active++;
	};
	const release = () => {
		active--;
		waiting.shift()?.();
	};
	return {
		async run(operation) {
			await acquire();
			try {
				return await operation();
			} finally {
				release();
			}
		},
	};
}

function cleanAgentOptions(options) {
	const ignored = new Set([
		"label",
		"name",
		"cache",
		"signal",
		"schemaRetries",
		"schemaOnInvalid",
		"timeoutMs",
		"phase",
	]);
	return Object.fromEntries(Object.entries(options ?? {}).filter(([key]) => !ignored.has(key)));
}

function jsonFromOutput(output) {
	const text = String(output).trim();
	const candidates = [text];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fenced) candidates.push(fenced[1].trim());
	const objectStart = text.indexOf("{");
	const arrayStart = text.indexOf("[");
	const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
	if (start >= 0) candidates.push(text.slice(start));
	for (const candidate of candidates) {
		try {
			return { ok: true, value: JSON.parse(candidate) };
		} catch {}
	}
	return { ok: false };
}

function createSchemaValidator(schema) {
	const ajv = new Ajv({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	return (value) => ({ ok: Boolean(validate(value)), errors: validate.errors ?? [] });
}

function unsupportedAgentOption(options) {
	for (const key of [
		"tools",
		"excludeTools",
		"skills",
		"extensions",
		"keys",
		"env",
		"inheritEnv",
		"agentType",
		"provider",
		"includeExtensions",
	]) {
		if (options?.[key] !== undefined) return key;
	}
	return undefined;
}

function packageScaffoldsDir() {
	const manifest = require.resolve("@pandi-coding-agent/pandi-dynamic-workflows/package.json");
	return path.join(path.dirname(manifest), "scaffolds");
}

function packageWorkflowsDir() {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");
}

async function resolveWorkflow(cwd, name) {
	if (!name || name.includes("\\") || name.split("/").some((part) => part === ".." || !part)) {
		throw new Error(`Invalid workflow name: ${name}`);
	}
	const candidates = [
		{ root: path.join(cwd, ".cursor", "ultracode", "workflows"), scope: "cursor-project" },
		{ root: packageWorkflowsDir(), scope: "cursor-host" },
		{ root: packageScaffoldsDir(), scope: "catalog" },
	];
	for (const candidate of candidates) {
		const file = inside(candidate.root, `${name}.js`);
		try {
			return { path: file, source: await fs.readFile(file, "utf8"), scope: candidate.scope };
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	throw new Error(`Workflow not found: ${name}`);
}

async function listFilesRecursive(directory, relative = "", output = []) {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const childRelative = path.join(relative, entry.name);
		if (entry.isDirectory()) {
			await listFilesRecursive(path.join(directory, entry.name), childRelative, output);
		} else if (entry.isFile()) {
			output.push(childRelative);
		}
		if (output.length > MAX_COLLECTION) throw new Error(`listFiles exceeded ${MAX_COLLECTION} entries.`);
	}
	return output;
}

function executeShell(command, cwd, env, signal, timeoutMs) {
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/sh", ["-lc", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (code === 0) resolve({ code, stdout, stderr });
			else reject(new Error(`bash exited ${code}: ${stderr.trim()}`));
		});
	});
}

async function executeWorkflow({ state, source, sourcePath, input, depth }) {
	const api = makeApi({ state, depth, sourcePath });
	const module = { exports: {} };
	const sandbox = vm.createContext({
		module,
		exports: module.exports,
		args: JSON.stringify(input ?? {}),
		limits: Object.freeze({ concurrency: state.options.concurrency, maxAgents: state.options.maxAgents }),
		runId: path.basename(state.runDir),
		runDir: state.runDir,
		cwd: state.cwd,
		...api,
		AbortController,
		JSON,
		Math,
		Promise,
		console: { log: (...parts) => api.log(parts.join(" ")) },
		setTimeout,
		clearTimeout,
	});
	const script = new vm.Script(transformWorkflowCode(source), { filename: sourcePath, displayErrors: true });
	script.runInContext(sandbox);
	if (typeof module.exports !== "function") throw new Error(`Workflow ${sourcePath} did not export a function.`);
	return await module.exports();
}

function makeApi({ state, depth, sourcePath }) {
	const { options, cwd, runDir } = state;
	const log = async (message, details) => {
		const event = {
			time: new Date().toISOString(),
			type: "log",
			message: String(message),
			...(details === undefined ? {} : { details }),
		};
		await fs.appendFile(path.join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
	};
	const phase = async (label) => {
		state.phase = label == null ? undefined : String(label);
		if (state.phase) await log(`phase: ${state.phase}`);
	};

	const agent = async (prompt, rawOptions = {}) => {
		if (typeof prompt !== "string") throw new Error("agent(prompt, options) requires a string prompt.");
		const unsupported = unsupportedAgentOption(rawOptions);
		if (unsupported) throw new Error(`Cursor host does not support per-agent ${unsupported}; refusing to ignore it.`);
		if (rawOptions.allowWrite && !options.allowAgentWrite) {
			throw new Error("Agent write access requires --allow-agent-write on the runner.");
		}
		if (rawOptions.allowWrite && !options.trustWorkspace) {
			throw new Error("Agent write access also requires an explicit --trust-workspace decision.");
		}
		const effective = { ...rawOptions };
		const key = hash(stable({ type: "agent", prompt, options: cleanAgentOptions(effective) }));
		if (effective.cache !== false && state.journal.calls[key]?.ok) {
			await log(`agent cache hit: ${effective.label ?? effective.name ?? "agent"}`, { key: key.slice(0, 12) });
			return state.journal.calls[key].value;
		}
		if (state.launchedAgents >= options.maxAgents)
			throw new Error(`Workflow exceeded maxAgents=${options.maxAgents}.`);
		const id = ++state.agentId;
		state.launchedAgents++;
		const name = slug(effective.label ?? effective.name ?? `agent-${id}`);
		const stem = path.join(runDir, "agents", `${String(id).padStart(4, "0")}-${name}`);
		const model = resolveCursorModel(effective.model ?? options.model, options.env);
		if (model.warning) await log(model.warning);
		const effort = effective.effort ?? effective.thinking ?? options.effort;
		if (effort)
			await log(
				`Cursor effort ${JSON.stringify(effort)} is advisory; the installed CLI exposes it only through parameterized model ids.`,
			);
		const command = buildCursorCommand({
			command: options.cursorCommand,
			commandArgs: options.cursorCommandArgs,
			cwd,
			model: model.model,
			allowWrite: effective.allowWrite === true,
			trustWorkspace: options.trustWorkspace,
		});
		const retries = Math.max(0, Number(effective.schemaRetries ?? 1));
		const validate = effective.schema ? createSchemaValidator(effective.schema) : undefined;
		let final;
		let stdout = "";
		let stderr = "";
		for (let attempt = 0; attempt <= retries; attempt++) {
			const retryPrompt =
				attempt === 0
					? prompt
					: `${prompt}\n\nYour previous response did not validate as the requested JSON schema. Return only valid JSON matching that schema.`;
			const result = await state.semaphore.run(
				async () =>
					await invokeCursor({
						...command,
						prompt: retryPrompt,
						cwd,
						env: options.env,
						signal: effective.signal,
						timeoutMs: Number(effective.timeoutMs ?? options.agentTimeoutMs),
					}),
			);
			stdout += result.stdout ?? "";
			stderr += result.stderr ?? "";
			if (!result.ok) {
				final = { ok: false, error: result.error };
				break;
			}
			if (!validate) {
				final = { ok: true, value: result.output, sessionId: result.sessionId };
				break;
			}
			const decoded = jsonFromOutput(result.output);
			const checked = decoded.ok
				? validate(decoded.value)
				: { ok: false, errors: [{ message: "response was not JSON" }] };
			if (checked.ok) {
				final = { ok: true, value: decoded.value, sessionId: result.sessionId };
				break;
			}
			final = { ok: false, error: `Cursor response failed schema validation: ${JSON.stringify(checked.errors)}` };
			await log(`agent ${id} schema retry ${attempt + 1}/${retries + 1}: ${name}`);
		}
		await fs.writeFile(`${stem}.stdout.log`, stdout, "utf8");
		await fs.writeFile(`${stem}.stderr.log`, stderr, "utf8");
		await fs.writeFile(
			`${stem}.md`,
			`# ${name}\n\n- status: ${final?.ok ? "completed" : "failed"}\n- phase: ${state.phase ?? "-"}\n- cache key: ${key}\n\n## Output\n\n${final?.ok ? (typeof final.value === "string" ? final.value : `\`\`\`json\n${JSON.stringify(final.value, null, 2)}\n\`\`\``) : (final?.error ?? "unknown failure")}\n`,
			"utf8",
		);
		if (!final?.ok) {
			await log(`agent ${id} failed: ${name}`, { error: final?.error });
			if (effective.schema && effective.schemaOnInvalid !== "null")
				throw new Error(final?.error ?? "Cursor agent failed.");
			return null;
		}
		if (effective.cache !== false) {
			state.journal.calls[key] = { ok: true, value: final.value, id, name, time: new Date().toISOString() };
			await writeJson(path.join(runDir, "journal.json"), state.journal);
		}
		await log(`agent ${id} completed: ${name}`, { sessionId: final.sessionId, key: key.slice(0, 12) });
		return final.value;
	};

	const agents = async (items, defaults = {}) => {
		if (!Array.isArray(items)) throw new Error("agents(items, options) requires an array.");
		if (items.length > MAX_COLLECTION) throw new Error(`agents() accepts at most ${MAX_COLLECTION} items.`);
		const requested = Number(defaults.concurrency ?? options.concurrency);
		const count = Math.max(
			1,
			Math.min(options.concurrency, Number.isFinite(requested) ? requested : options.concurrency),
		);
		if (requested > options.concurrency)
			await log(`agents concurrency clamped ${requested} -> ${options.concurrency}`);
		const local = makeSemaphore(count);
		return await Promise.all(
			items.map((item, _index) =>
				local.run(async () => {
					const spec = typeof item === "string" ? { prompt: item } : item;
					try {
						const value = await agent(spec?.prompt, {
							...defaults,
							...spec,
							concurrency: undefined,
							settle: undefined,
						});
						return value == null
							? null
							: {
									output: typeof value === "string" ? value : undefined,
									data: typeof value === "object" ? value : undefined,
									schemaOk: Boolean(spec?.schema ?? defaults.schema),
								};
					} catch (error) {
						if (defaults.settle) return null;
						throw error;
					}
				}),
			),
		);
	};

	const parallel = async (thunks) => {
		if (!Array.isArray(thunks) || thunks.length > MAX_COLLECTION)
			throw new Error(`parallel() requires 0..${MAX_COLLECTION} functions.`);
		return await Promise.all(
			thunks.map(async (thunk) => {
				try {
					return await thunk();
				} catch (error) {
					await log("parallel branch failed", { error: String(error?.message ?? error) });
					return null;
				}
			}),
		);
	};

	const pipeline = async (items, ...rest) => {
		if (!Array.isArray(items) || items.length > MAX_COLLECTION)
			throw new Error(`pipeline() accepts at most ${MAX_COLLECTION} items.`);
		const tail = rest.at(-1);
		const config = tail && typeof tail === "object" && typeof tail !== "function" ? rest.pop() : {};
		const stages = rest;
		if (!stages.length || stages.some((stage) => typeof stage !== "function"))
			throw new Error("pipeline() requires one or more stage functions.");
		const requested = Number(config.inFlight ?? options.concurrency);
		const local = makeSemaphore(
			Math.max(1, Math.min(options.concurrency, Number.isFinite(requested) ? requested : options.concurrency)),
		);
		return await Promise.all(
			items.map((item, index) =>
				local.run(async () => {
					try {
						let value = item;
						for (const stage of stages) value = await stage(value, item, index);
						return value;
					} catch (error) {
						await log("pipeline item failed", { index, error: String(error?.message ?? error) });
						return null;
					}
				}),
			),
		);
	};

	const race = async (thunks, { accept = (value) => value != null } = {}) => {
		if (!Array.isArray(thunks) || thunks.length === 0 || thunks.some((thunk) => typeof thunk !== "function")) {
			throw new Error("race() requires a non-empty array of functions.");
		}
		const controllers = thunks.map(() => new AbortController());
		const errors = [];
		return await new Promise((resolve) => {
			let remaining = thunks.length;
			let settled = false;
			thunks.forEach((thunk, index) => {
				Promise.resolve()
					.then(() => thunk(controllers[index].signal))
					.then((value) => {
						if (!settled && accept(value)) {
							settled = true;
							controllers.forEach((controller, other) => {
								if (other !== index) controller.abort();
							});
							resolve({ winner: value, index, status: "won", ...(errors.length ? { errors } : {}) });
						}
					})
					.catch((error) => errors.push({ index, error: String(error?.message ?? error) }))
					.finally(() => {
						remaining--;
						if (!settled && remaining === 0)
							resolve({ winner: null, index: -1, status: "empty", ...(errors.length ? { errors } : {}) });
					});
			});
		});
	};

	const workflow = async (name, workflowInput = {}) => {
		if (depth >= options.maxWorkflowDepth)
			throw new Error(`workflow() composition depth limit is ${options.maxWorkflowDepth}.`);
		const nested = await resolveWorkflow(cwd, name);
		if (nested.path === sourcePath) throw new Error(`workflow() refused recursive call to ${name}.`);
		await log(`sub-workflow start: ${name}`);
		const output = await executeWorkflow({
			state,
			source: nested.source,
			sourcePath: nested.path,
			input: workflowInput,
			depth: depth + 1,
		});
		await log(`sub-workflow end: ${name}`);
		return output;
	};

	const ask = async (question, askOptions = {}) => {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			if (askOptions.default !== undefined) return askOptions.default;
			throw new Error(`ask() needs a TTY host; pass a default for headless Cursor runs. Question: ${question}`);
		}
		const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
		try {
			const suffix = askOptions.default === undefined ? "" : ` [${askOptions.default}]`;
			const answer = await terminal.question(`${question}${suffix}: `);
			return answer || askOptions.default;
		} finally {
			terminal.close();
		}
	};

	return {
		agent,
		agents,
		parallel,
		pipeline,
		race,
		workflow,
		phase,
		log,
		ask,
		bash: async (command, bashOptions = {}) => {
			if (!options.allowWorkflowShell) throw new Error("bash() requires --allow-workflow-shell on the runner.");
			return await executeShell(
				command,
				cwd,
				options.env,
				bashOptions.signal,
				Number(bashOptions.timeoutMs ?? options.agentTimeoutMs),
			);
		},
		readFile: async (file, encoding = "utf8") => await fs.readFile(inside(cwd, file), encoding),
		writeFile: async (file, data) => {
			if (!options.allowWorkflowWrite) throw new Error("writeFile() requires --allow-workflow-write on the runner.");
			const destination = inside(cwd, file);
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.writeFile(destination, data);
		},
		appendFile: async (file, data) => {
			if (!options.allowWorkflowWrite)
				throw new Error("appendFile() requires --allow-workflow-write on the runner.");
			const destination = inside(cwd, file);
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.appendFile(destination, data);
		},
		listFiles: async (directory = ".") => await listFilesRecursive(inside(cwd, directory)),
	};
}

/** Run a portable workflow locally while Cursor CLI supplies each agent() worker. */
export async function runWorkflow(rawOptions) {
	const cwd = path.resolve(rawOptions.cwd ?? process.cwd());
	const options = {
		cwd,
		name: rawOptions.name,
		input: rawOptions.input ?? {},
		concurrency: Math.max(1, Number(rawOptions.concurrency ?? 4)),
		maxAgents: Math.max(1, Number(rawOptions.maxAgents ?? 32)),
		maxWorkflowDepth: Math.max(0, Number(rawOptions.maxWorkflowDepth ?? 1)),
		agentTimeoutMs: Math.max(1, Number(rawOptions.agentTimeoutMs ?? DEFAULT_TIMEOUT_MS)),
		cursorCommand: rawOptions.cursorCommand ?? process.env.PANDI_CURSOR_COMMAND ?? "cursor-agent",
		cursorCommandArgs: rawOptions.cursorCommandArgs ?? [],
		model: rawOptions.model,
		effort: rawOptions.effort,
		allowAgentWrite: rawOptions.allowAgentWrite === true,
		trustWorkspace: rawOptions.trustWorkspace === true,
		allowWorkflowWrite: rawOptions.allowWorkflowWrite === true,
		allowWorkflowShell: rawOptions.allowWorkflowShell === true,
		env: { ...process.env, ...(rawOptions.env ?? {}) },
	};
	const fresh = !rawOptions.resume;
	const definition = fresh ? await resolveWorkflow(cwd, options.name) : undefined;
	const defaultRunDir = path.join(
		cwd,
		".cursor",
		"ultracode",
		"runs",
		`${new Date().toISOString().replace(/[:.]/g, "-")}-${slug(options.name)}`,
	);
	const runDir = path.resolve(rawOptions.runDir ?? defaultRunDir);
	if (!runDir.startsWith(path.join(cwd, ".cursor", "ultracode", "runs") + path.sep)) {
		throw new Error("Run directory must stay below .cursor/ultracode/runs.");
	}
	await fs.mkdir(path.join(runDir, "agents"), { recursive: true });
	let source;
	let sourcePath;
	let input = options.input;
	if (fresh) {
		source = definition.source;
		sourcePath = definition.path;
		await fs.writeFile(path.join(runDir, "workflow-source.js"), source, "utf8");
		await fs.writeFile(path.join(runDir, "workflow-transformed.cjs"), transformWorkflowCode(source), "utf8");
		await writeJson(path.join(runDir, "input.json"), input);
	} else {
		source = await fs.readFile(path.join(runDir, "workflow-source.js"), "utf8");
		sourcePath = path.join(runDir, "workflow-source.js");
		input = await readJson(path.join(runDir, "input.json"), {});
	}
	const journal = await readJson(path.join(runDir, "journal.json"), { version: 1, calls: {} });
	const state = {
		options,
		cwd,
		runDir,
		journal,
		agentId: Object.values(journal.calls).reduce((max, entry) => Math.max(max, Number(entry.id ?? 0)), 0),
		launchedAgents: 0,
		semaphore: makeSemaphore(options.concurrency),
		phase: undefined,
	};
	await writeJson(path.join(runDir, "status.json"), {
		state: "running",
		workflow: options.name,
		startedAt: new Date().toISOString(),
		resume: !fresh,
	});
	try {
		const result = portableValue(await executeWorkflow({ state, source, sourcePath, input, depth: 0 }));
		await writeJson(path.join(runDir, "result.json"), { workflow: options.name, result });
		await fs.writeFile(
			path.join(runDir, "summary.md"),
			`# ${options.name}\n\n- state: completed\n- launched agents: ${state.launchedAgents}\n`,
			"utf8",
		);
		await writeJson(path.join(runDir, "status.json"), {
			state: "completed",
			workflow: options.name,
			completedAt: new Date().toISOString(),
			launchedAgents: state.launchedAgents,
		});
		return { runDir, result, launchedAgents: state.launchedAgents };
	} catch (error) {
		await writeJson(path.join(runDir, "status.json"), {
			state: "failed",
			workflow: options.name,
			failedAt: new Date().toISOString(),
			error: String(error?.message ?? error),
		});
		throw error;
	}
}

export async function listWorkflows(cwd) {
	const entries = [];
	for (const candidate of [
		{ root: path.join(cwd, ".cursor", "ultracode", "workflows"), scope: "cursor-project" },
		{ root: packageWorkflowsDir(), scope: "cursor-host" },
		{ root: packageScaffoldsDir(), scope: "catalog" },
	]) {
		try {
			for (const file of await fs.readdir(candidate.root)) {
				const name = file.endsWith(".js") ? file.slice(0, -3) : undefined;
				if (name && !entries.some((entry) => entry.name === name)) entries.push({ name, scope: candidate.scope });
			}
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export async function checkWorkflow({ cwd = process.cwd(), name }) {
	const workflow = await resolveWorkflow(path.resolve(cwd), name);
	transformWorkflowCode(workflow.source);
	return { name, scope: workflow.scope, path: workflow.path, ok: true };
}
