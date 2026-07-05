/**
 * Código fuente del Worker de ejecución de dynamic-workflows, mantenido tal cual como
 * literal template String.raw. Se instancia con `new Worker(source, { eval: true })`
 * en index.ts, ejecutándose en un contexto worker CommonJS fresco (sus llamadas
 * `require("node:worker_threads")` / `require("node:vm")` son válidas ahí, NO importes
 * ESM en este módulo). BYTE-SENSITIVE: el worker agrupa/ejecuta este texto exacto; no
 * reformatees, re-indentess, ni "acomodess" el contenido.
 *
 * Movido de index.ts tal cual (preservando comportamiento); solo cambió la ubicación
 * de la declaración. Sibling a profundidad uno para que se incluya en el glob `files`.
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

// Enlazar un AbortSignal por-llamada al host: postear abort-call permite al host abortar
// exactamente el CombinedSignal de esta llamada (usado por losers de race()). Compartido por
// agent() y ask() (mismo archivo, intencional).
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

// race(thunks, { accept? }) -> { winner, index, status }. Abre en abanico N ramas y, en el
// momento en que una produce un valor ACEPTADO (default: != null), aborta los losers en vuelo
// mediante el AbortSignal que cada thunk recibe. Puro en-worker: cancelación viaja por el id
// hostCall por-llamada (agentGlobal postea abort-call cuando su signal dispara). Cada rama
// tiene un rejection handler así un loser cancelado nunca emerge como unhandled rejection.
async function race(thunks, options) {
  if (!Array.isArray(thunks) || thunks.length === 0)
    throw new Error("race(thunks) expects a non-empty array of functions.");
  if (!thunks.every((t) => typeof t === "function"))
    throw new Error("race() thunks must be functions: (signal) => Promise.");
  const accept = (options && options.accept) || ((v) => v != null);
  const controller = new AbortController();
  // Fan-out síncrono (map, no then encadenado) así el primer hostCall de cada thunk postea
  // en orden de emisión -> asignación determinística de occ bajo el mutex occ del host.
  const promises = thunks.map((thunk) => {
    try { return Promise.resolve(thunk(controller.signal)); }
    catch (e) { return Promise.reject(e); }
  });
  return await new Promise((resolve) => {
    let settled = false;
    let remaining = thunks.length;
    // Rejections se coleccionan (no se descartan): un bug genuino de thunk solía ser
    // indistinguible de "todas las ramas declinaron" — ambas devolvían un bare
    // status:"empty". El campo aditivo errors[] mantiene una race all-rejected
    // debuggable sin cambiar la semántica de winner/index/status.
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

  // Interfaz única de autoría: workflows llamam GLOBALS inyectados (no ctx.*). El global agent()
  // es un thin wrapper sobre el host bridge que (1) mapea effort->thinking y label->name, (2)
  // devuelve el objeto parseado para schema calls / el text output en otro caso, y (3) cede null
  // en un subagent fallido (ok:false) así settle semantics de parallel()/pipeline() y contabilidad
  // de partial-failure permanecen honest. phase(label) es un marcador de observabilidad lightweight.
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
    // El mensaje "call" se postea (dentro de hostCallTracked) ANTES de que se attache este
    // listener, así abort-call nunca puede llegar al host antes de su call -> el host siempre
    // registra el controlador per-id primero. Un signal ya-abortado postea abort-call inmediatamente.
    bridgeAbortToHost(sig, id);
    const res = await promise;
    if (res == null || res.ok === false) return null;
    return opts.schema !== undefined ? (res.data != null ? res.data : null) : res.output;
  };
  // ask(question, options?) -> la respuesta del humano (string para input/select, boolean para
  // confirm). Espeja el per-call signal bridge de agentGlobal así un ask dialog de race() loser se
  // despide: la signal se quita antes de postear (nunca serialices un AbortSignal) y un abort
  // postea abort-call para este id. A diferencia de agentGlobal NO engulle ok:false -> un host
  // error (p. ej. headless sin default, o un diálogo abortado) rechaza, emergiendo como error
  // lanzado en el workflow.
  const askGlobal = async (question, options) => {
    const opts = Object.assign({}, options || {});
    const sig = opts.signal;
    delete opts.signal;
    const { id, promise } = hostCallTracked("ask", [question, opts]);
    bridgeAbortToHost(sig, id);
    return await promise;
  };
  // agents(items, options?) -> array of SubagentResult|null. Espeja el per-call signal bridge de
  // agentGlobal así un race() loser que se abre en abanico via agents() tiene sus children in-flight
  // cancelados EN race-loss (no solo al final del run): quita la signal antes de postear (nunca
  // serialices un AbortSignal) y postea abort-call para este id en abort. Todas las otras opciones
  // (model/effort/schema/label/concurrency/settle) pasan sin tocar: el HOST normaliza el worker
  // sugar — effort->thinking (max->xhigh) en el prologue runSubagent (por item Y para opciones
  // shared) y label->name por item en runAgents — espejando agentGlobal arriba.
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
    if (currentPhaseLabel) void hostCall("phase", [currentPhaseLabel]);
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
    // Contexto de run read-only como globals planos (superset de helper-globals): un script
    // workflow top-level llega a los limits/ids del run sin un objeto ctx.
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
