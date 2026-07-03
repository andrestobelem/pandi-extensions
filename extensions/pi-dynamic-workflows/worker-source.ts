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

function hostCallTracked(method, args) {
  const id = nextCallId++;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  parentPort.postMessage({ type: "call", id, method, args });
  return { id, promise };
}

function hostCall(method, args) {
  return hostCallTracked(method, args).promise;
}

// Bridge a per-call AbortSignal to the host: posting abort-call lets the host abort exactly this
// call's CombinedSignal (used by race() losers). Shared by agent() and ask() (same file, intentional).
function bridgeAbortToHost(sig, id) {
  if (!sig) return;
  if (sig.aborted) {
    try { parentPort.postMessage({ type: "abort-call", id }); } catch {}
    return;
  }
  sig.addEventListener("abort", () => {
    try { parentPort.postMessage({ type: "abort-call", id }); } catch {}
  }, { once: true });
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

// race(thunks, { accept? }) -> { winner, index, status }. Fans out N branches and, the moment one
// produces an ACCEPTED value (default: != null), aborts the in-flight losers via the AbortSignal each
// thunk receives. Pure in-worker: cancellation rides the per-call hostCall id (agentGlobal posts
// abort-call when its signal fires). Every branch has a rejection handler so a cancelled loser never
// surfaces as an unhandled rejection.
async function race(thunks, options) {
  if (!Array.isArray(thunks) || thunks.length === 0)
    throw new Error("race(thunks) expects a non-empty array of functions.");
  if (!thunks.every((t) => typeof t === "function"))
    throw new Error("race() thunks must be functions: (signal) => Promise.");
  const accept = (options && options.accept) || ((v) => v != null);
  const controller = new AbortController();
  // Synchronous fan-out (map, not chained then) so each thunk's first hostCall posts in emission
  // order -> deterministic occ assignment under the host occ mutex.
  const promises = thunks.map((thunk) => {
    try { return Promise.resolve(thunk(controller.signal)); }
    catch (e) { return Promise.reject(e); }
  });
  return await new Promise((resolve) => {
    let settled = false;
    let remaining = thunks.length;
    // Rejections are collected (not discarded): a genuine thunk bug used to be
    // indistinguishable from "every branch declined" — both returned a bare
    // status:"empty". The additive errors[] field keeps an all-rejected race
    // debuggable without changing the winner/index/status semantics.
    const errors = [];
    const finish = (index, winner, status) => {
      if (settled) return;
      settled = true;
      controller.abort(); // signals every in-flight loser -> abort-call per id (cross-thread)
      resolve(errors.length ? { winner, index, status, errors } : { winner, index, status });
    };
    promises.forEach((p, index) => p.then(
      (value) => {
        if (settled) return;
        if (accept(value, index)) finish(index, value, "won");
        else if (--remaining === 0) finish(-1, null, "empty");
      },
      (err) => {
        if (settled) return;
        errors.push({ index, error: err && err.message ? err.message : String(err) });
        if (--remaining === 0) finish(-1, null, "empty");
      },
    ));
  });
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
    race: (thunks, options) => race(thunks, options),
    ask: (question, options) => hostCall("ask", [question, options]),
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

  // Single authoring interface: workflows call injected GLOBALS (no ctx.*). The agent() global is a
  // thin wrapper over the host bridge that (1) maps effort->thinking and label->name, (2) returns the
  // parsed object for schema calls / the text output otherwise, and (3) yields null on a failed
  // subagent (ok:false) so parallel()/pipeline() settle semantics and partial-failure accounting stay
  // honest. phase(label) is a lightweight observability marker.
  const mapEffort = (e) => (e === "max" ? "xhigh" : e);
  const agentGlobal = async (prompt, options) => {
    const opts = Object.assign({}, options || {});
    const sig = opts.signal; // never serialize an AbortSignal -> DataCloneError
    delete opts.signal;
    if (opts.label != null && opts.name == null) opts.name = opts.label;
    delete opts.label;
    if (opts.effort != null && opts.thinking == null) opts.thinking = mapEffort(opts.effort);
    delete opts.effort;
    delete opts.phase;
    const { id, promise } = hostCallTracked("agent", [prompt, opts]);
    // The "call" message is posted (inside hostCallTracked) BEFORE this listener attaches, so an
    // abort-call can never reach the host before its call -> the host always registers the per-id
    // controller first. An already-aborted signal posts abort-call immediately.
    bridgeAbortToHost(sig, id);
    const res = await promise;
    if (res == null || res.ok === false) return null;
    return opts.schema !== undefined ? (res.data != null ? res.data : null) : res.output;
  };
  // ask(question, options?) -> the human's answer (string for input/select, boolean for confirm).
  // Mirrors agentGlobal's per-call signal bridge so a race() loser's ask dialog is dismissed: the
  // signal is stripped before posting (never serialize an AbortSignal) and an abort posts abort-call
  // for this id. Unlike agentGlobal it does NOT swallow ok:false -> a host error (e.g. headless with
  // no default, or an aborted dialog) rejects, surfacing as a thrown error in the workflow.
  const askGlobal = async (question, options) => {
    const opts = Object.assign({}, options || {});
    const sig = opts.signal;
    delete opts.signal;
    const { id, promise } = hostCallTracked("ask", [question, opts]);
    bridgeAbortToHost(sig, id);
    return await promise;
  };
  // agents(items, options?) -> array of SubagentResult|null. Mirrors agentGlobal's per-call signal
  // bridge so a race() loser that fans out via agents() has its in-flight children cancelled AT
  // race-loss (not just at run end): strip the signal before posting (never serialize an
  // AbortSignal) and post abort-call for this id on abort. All other options (model/effort/schema/
  // label/concurrency/settle) pass through untouched -> the HOST's runAgents maps them per item.
  const agentsGlobal = (items, options) => {
    const opts = Object.assign({}, options || {});
    const sig = opts.signal;
    delete opts.signal;
    const { id, promise } = hostCallTracked("agents", [items, opts]);
    bridgeAbortToHost(sig, id);
    return promise;
  };
  let currentPhaseLabel = null;
  const phase = (label) => {
    currentPhaseLabel = label == null ? null : String(label);
    if (currentPhaseLabel) void hostCall("log", ["phase: " + currentPhaseLabel]);
  };

  try {
    sandbox.agent = agentGlobal;
    sandbox.agents = agentsGlobal;
    sandbox.parallel = ctx.parallel;
    sandbox.pipeline = ctx.pipeline;
    sandbox.race = ctx.race;
    sandbox.ask = askGlobal;
    sandbox.workflow = ctx.workflow;
    sandbox.log = ctx.log;
    sandbox.phase = phase;
    sandbox.bash = ctx.bash;
    sandbox.readFile = ctx.readFile;
    sandbox.writeFile = ctx.writeFile;
    sandbox.appendFile = ctx.appendFile;
    sandbox.listFiles = ctx.listFiles;
    sandbox.writeArtifact = ctx.writeArtifact;
    sandbox.appendArtifact = ctx.appendArtifact;
    sandbox.sleep = ctx.sleep;
    sandbox.json = ctx.json;
    sandbox.compact = ctx.compact;
    sandbox.args = workerData.input;
    // Read-only run context as flat globals (superset of the helper-globals): a top-level
    // workflow script reaches the run's limits/ids without a ctx object.
    sandbox.limits = limits;
    sandbox.runId = ctx.runId;
    sandbox.runDir = ctx.runDir;
    sandbox.cwd = ctx.cwd;
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
      throw new Error("Workflow must export a function: use export default async function main() { ... }, or a top-level script that ends in return.");
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
