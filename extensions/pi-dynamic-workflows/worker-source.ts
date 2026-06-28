/**
 * Source code of the dynamic-workflows execution Worker, kept verbatim as a
 * String.raw template literal. It is instantiated with `new Worker(source,
 * { eval: true })` in index.ts, so it runs in a fresh CommonJS worker context
 * (its `require("node:worker_threads")` / `require("node:vm")` are valid there,
 * NOT ESM imports in this module). BYTE-SENSITIVE: the worker bundles/executes
 * this exact text; do not reformat, re-indent, or "tidy" the contents.
 *
 * Moved out of index.ts verbatim (behavior-preserving); only the declaration
 * location changed. Depth-one sibling so it ships under the `files` glob.
 */

export const WORKFLOW_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

let nextCallId = 1;
const pending = new Map();

function compact(value, maxChars = 24000) {
  let text;
  if (typeof value === "string") text = value;
  else {
    const seen = new WeakSet();
    text = JSON.stringify(value, (_key, current) => {
      if (typeof current === "bigint") return current.toString();
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    }, 2);
  }
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 120)) + "\n\n...[truncated " + (text.length - maxChars) + " chars]";
}

function hostCall(method, args) {
  const id = nextCallId++;
  parentPort.postMessage({ type: "call", id, method, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "response") return;
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  if (message.ok) handler.resolve(message.result);
  else handler.reject(new Error(message.error || "Workflow host call failed"));
});

function send(type, payload) {
  try {
    parentPort.postMessage({ type, ...payload });
  } catch (err) {
    parentPort.postMessage({ type: "error", error: err && err.stack ? err.stack : String(err) });
  }
}

async function parallel(thunks, concurrency) {
  if (!Array.isArray(thunks)) throw new Error("parallel(thunks) expects an array of functions.");
  const results = new Array(thunks.length).fill(null);
  let next = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency || 1)), thunks.length || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= thunks.length) return;
      const thunk = thunks[index];
      if (typeof thunk !== "function") {
        results[index] = null;
        continue;
      }
      try {
        results[index] = await thunk();
      } catch {
        results[index] = null;
      }
    }
  }));
  return results;
}

async function pipeline(items, concurrency, ...stagesAndOptions) {
  if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) expects an array of items.");
  if (items.length > 4096) throw new Error("pipeline() supports at most 4096 items per call; chunk the work-list explicitly.");
  const maybeOptions = stagesAndOptions.length && typeof stagesAndOptions[stagesAndOptions.length - 1] === "object" && typeof stagesAndOptions[stagesAndOptions.length - 1] !== "function"
    ? stagesAndOptions.pop()
    : undefined;
  const stages = stagesAndOptions;
  if (stages.length === 0) return items.slice();
  if (!stages.every((stage) => typeof stage === "function")) throw new Error("pipeline stages must be functions.");
  const requested = maybeOptions && Number.isFinite(maybeOptions.inFlight) ? maybeOptions.inFlight : concurrency;
  const inFlight = Math.min(Math.max(1, Math.floor(requested || 1)), Math.max(1, concurrency || 1), items.length || 1);
  const results = new Array(items.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: inFlight }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const original = items[index];
      try {
        let value = original;
        for (const stage of stages) value = await stage(value, original, index);
        results[index] = value;
      } catch {
        results[index] = null;
      }
    }
  }));
  return results;
}

(async () => {
  const moduleObj = { exports: {} };
  const limits = Object.freeze({ ...workerData.limits });
  const ctx = {
    cwd: workerData.cwd,
    runId: workerData.runId,
    runDir: workerData.runDir,
    input: workerData.input,
    limits,
    log: (...args) => hostCall("log", args),
    agent: (prompt, options) => hostCall("agent", [prompt, options]),
    agents: (items, options) => hostCall("agents", [items, options]),
    workflow: (name, input) => hostCall("workflow", [name, input]),
    parallel: (thunks) => parallel(thunks, limits.concurrency),
    pipeline: (items, ...stages) => pipeline(items, limits.concurrency, ...stages),
    bash: (command, options) => hostCall("bash", [command, options]),
    readFile: (filePath, encoding) => hostCall("readFile", [filePath, encoding]),
    writeFile: (filePath, data) => hostCall("writeFile", [filePath, data]),
    appendFile: (filePath, data) => hostCall("appendFile", [filePath, data]),
    listFiles: (dir, options) => hostCall("listFiles", [dir, options]),
    writeArtifact: (name, data) => hostCall("writeArtifact", [name, data]),
    appendArtifact: (name, data) => hostCall("appendArtifact", [name, data]),
    sleep: (ms) => hostCall("sleep", [ms]),
    json: compact,
    compact,
  };

  const workflowConsole = {
    log: (...args) => void hostCall("log", [args.map((arg) => typeof arg === "string" ? arg : compact(arg)).join(" ")]),
    warn: (...args) => void hostCall("log", [args.map((arg) => typeof arg === "string" ? arg : compact(arg)).join(" ")]),
    error: (...args) => void hostCall("log", [args.map((arg) => typeof arg === "string" ? arg : compact(arg)).join(" ")]),
  };

  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    console: workflowConsole,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
    structuredClone,
    fetch: globalThis.fetch,
    AbortController,
    AbortSignal,
    crypto: globalThis.crypto,
  };

  try {
    sandbox.parallel = ctx.parallel;
    sandbox.pipeline = ctx.pipeline;
    const context = vm.createContext(sandbox, { name: "pi-workflow:" + workerData.workflowName });
    const script = new vm.Script(workerData.code, { filename: workerData.filePath });
    script.runInContext(context, { timeout: limits.syncTimeoutMs });

    let exported = moduleObj.exports;
    if (exported && typeof exported === "object" && typeof exported.default === "function") exported = exported.default;
    if (typeof exported !== "function") {
      const maybeMain = sandbox.main || sandbox.workflow;
      if (typeof maybeMain === "function") exported = maybeMain;
    }
    if (typeof exported !== "function") {
      throw new Error("Workflow must export a function: module.exports = async function workflow(ctx, input) { ... }.");
    }

    sandbox.__workflow = exported;
    sandbox.__ctx = ctx;
    sandbox.__input = workerData.input;
    const result = vm.runInContext("__workflow(__ctx, __input)", context, { timeout: limits.syncTimeoutMs });
    send("result", { result: await Promise.resolve(result) });
  } catch (err) {
    send("error", { error: err && err.stack ? err.stack : String(err) });
  }
})();
`;
