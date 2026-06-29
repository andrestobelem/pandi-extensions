# pi-dynamic-workflows — Consolidated Review Findings

Multi-agent audit (exhaustive review + 2 loop-until-dry passes), modern-software-engineering rubric, adversarial jury-verified. **45 distinct findings.**

Severity: {'high': 13, 'medium': 21, 'low': 11}

> Audit never ran dry — coverage is good but not exhaustive; the worker-source VM bridge, journal/resume, and parallel/agents contracts are the hot zones.


## HIGH

- **JSON extractor only tries the first '{' and '[' — returns the wrong object from multi-segment output** — `json-extract.ts:24` _(review)_
  - Fix: Collect ALL '{'/'[' positions, sort, and iterate: for (let i=0;i<textValue.length;i++){const c=textValue[i]; if(c==='{'||c==='[')starts.push(i);} then run the existing balanced walk per start. Smallest safe reversible change to one line. Missing test that should exist: a json-ext
- **artifactPath from events.jsonl reaches fs.readFile with no path containment — arbitrary file read** — `agent-view.ts:22-24 (read at :54); source event-parser.ts:253` _(review)_
  - Fix: In resolveAgentArtifactPath, replace the isAbsolute/path.join branch with resolveInsideRoot(run.runDir, ..., 'workflow run directory') wrapped in try/catch returning undefined on escape (UI degrades gracefully). Reject absolute paths outright as resolveArtifactPath already does.
- **Cache occ determinism guarantee is false for ctx.parallel/ctx.pipeline — resume can return the wrong cached result** — `index.ts:528-538 (nextOcc on message arrival) + worker-source.ts:61-113` _(review)_
  - Fix: Smallest safe slice now: correct the comment to state determinism only for ctx.agents/mapLimit, and add a guard that warns when nextOcc returns occ>0 for a key first seen inside a parallel/pipeline frame. Durable fix: derive occ from a worker-assigned monotonic branch/call index
- **Resume silently swallows all input.json errors and re-runs with empty input / lost limits** — `run-lifecycle.ts:240-244` _(review)_
  - Fix: Distinguish ENOENT (acceptable {} fallback) from parse/permission errors: catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }. Surface parse/EACCES in the resumed run status. Missing test: resume with a corrupt input.json asserts the run fails loudly
- **Unguarded handleDashboardChoice in the dashboard reopen loop crashes the entire TUI on bad input** — `dashboard-orchestration.ts:354 (throw sites in handleDashboardChoice ~:435,:463 and loadRerunInput ~:155-158)` _(review)_
  - Fix: Wrap the handleDashboardChoice call at :354 in try/catch that notifies via ctx.ui and continues the loop (no rethrow); guard loadRerunInput's second parseCliJsonOrText to return undefined (cancel) on parse failure. Smallest reversible slice is the loop-level catch. Missing test:
- **agents() global bypasses effort->thinking and label->name transforms that agent() applies** — `worker-source.ts:192-193` _(loop-1)_
  - Fix: Extract the option-normalization in agentGlobal (lines 174-180) into a shared mapAgentOptions(opts) helper and apply it inside an agentsGlobal wrapper that maps each item's options before calling ctx.agents. Wire sandbox.agents to that wrapper. Test: a worker-level unit test asse
- **vm.runInContext timeout does not bound the async workflow body — runaway/hung orchestration is never killed by syncTimeoutMs** — `worker-source.ts:233` _(loop-1)_
  - Fix: Either remove the misleading timeout option (and document that only per-subagent timeouts apply), or wrap the awaited result in a real wall-clock guard: Promise.race([Promise.resolve(result), rejectAfter(limits.wallClockMs)]) with an explicit orchestration-level budget. Test: a w
- **parallel() and pipeline() collapse thrown errors to null — genuine failures are indistinguishable from intentional null returns** — `worker-source.ts:75-81 (parallel), 103-111 (pipeline)` _(loop-1)_
  - Fix: In the catch, emit a host log with the error before storing null (void hostCall('log',['parallel thunk '+index+' threw: '+(e?.stack||e)])), so failures are visible in the journal/events even though the settle-to-null contract is preserved. Optionally surface a parallel error coun
- **Per-record codeHash written to the journal but never validated on replay — stale cached results served after a code change** — `journal.ts:94-113 (loadJournal); record.codeHash written in index.ts` _(loop-1)_
  - Fix: In loadJournal (or at lookup time) skip/invalidate any record whose codeHash !== current computeCodeHash. Smallest safe change: filter records by codeHash during cache assembly when a current hash is passed in. Test: write a journal record under hash A, resume under hash B, asser
- **void open(...).finally() does not swallow rejection — unhandled promise rejection can crash the process** — `dashboard-down-editor.ts:273 (finding mislabeled as dashboard-orchestration.ts:265)` _(loop-1)_
  - Fix: Add a .catch before/with .finally: `open(...).then(()=>{}, (err)=>{ /* log via ctx.notify or console */ }).finally(()=>{ this.opening=false })`. Test: stub open to reject and assert no unhandled rejection escapes and this.opening is reset to false.
- **Schema retries run on silently truncated output; retry prompt misattributes the failure to a schema mismatch** — `index.ts:944-962` _(loop-1)_
  - Fix: Run extractJsonCandidate/validateStructuredData on the UNtruncated parsed output (truncate only the stored/journaled copy), or detect host-side truncation (output.length === cap) and report it accurately in the retry prompt. Test: feed a >24000-char valid-JSON stdout and assert e
- **agents(settle:true) silently swallows maxAgents-exceeded as a null result with no journal/event trace** — `pi-dynamic-workflows/index.ts:787-789, 1117` _(loop-2)_
  - Fix: Distinguish capacity rejection from content null. Smallest safe fix: before throwing at 788, emit a structured event/log (e.g. appendEvent({type:"agent", state:"rejected", reason:"maxAgents"})) so the run record shows the capacity hit; better, have mapLimit's onError handler tag
- **TOCTOU race: concurrent resumeWorkflow calls both pass the activeRuns guard; the second overwrites the first AbortController, orphaning a live run** — `pi-dynamic-workflows/run-lifecycle.ts:213 (set at 135)` _(loop-2)_
  - Fix: Close the window by reserving the runId synchronously the moment the guard passes — e.g. set a placeholder activeRuns entry (or a Set<string> of in-flight runIds) at line 213/214 before any await, then replace it with the real ActiveWorkflowRun at 135; reject the second caller on

## MEDIUM

- **getRunDirs rejects for ALL runs if any single run dir vanishes between readdir and stat** — `run-store.ts:32-41` _(review)_
  - Fix: Wrap the per-entry stat in try/catch returning undefined and filter, or use Promise.allSettled keeping only fulfilled — matching the already-correct pattern in collectPiSessions. Missing test: list with a directory deleted mid-enumeration (simulated stat rejection) asserts surviv
- **Subagents inherit the orchestrator's full process.env (all secrets) by default** — `index.ts:821-830 (env spread) + agent-env-persona.ts:127-129` _(review)_
  - Fix: Smallest safe slice: strip well-known provider secret vars from the inherited env unless explicitly listed in keys, and document the default loudly at the keys schema field. Larger change: flip default so subagents get a minimal base env unless inheritEnv:true. Reversible via the
- **onStdout/onStderr callback rejections become unhandled promise rejections** — `process-spawn.ts:127,131` _(review)_
  - Fix: Either await the callback inside an async data handler, or .catch() the returned promise and route the error into finish(). Smallest slice: void Promise.resolve(options.onStdout?.(chunk)).catch(()=>{}). Missing test: a callback that rejects asserts no unhandled rejection and the
- **startPiSessionHeartbeat can leak an interval and resurrect a deleted session file under fast shutdown** — `pi-session.ts:133-136` _(review)_
  - Fix: After the awaited first write, bail if ownership was lost: if (livePiSession !== runtime) return; immediately before creating the interval. Optionally no-op the interval body when livePiSession !== runtime. Keeps the start/stop contract intact. Missing test: invoke start then sto
- **formatLiveRunView receives explicit undefined width in non-TUI mode, defeating the width=80 default** — `run-status-ui.ts:156 (callsite) / 126-133 (defn)` _(review)_
  - Fix: Pass a concrete width: formatLiveRunView(logs, workflowName, 80, status). Smallest reversible change. Missing test: call setWorkflowWidget with ctx.mode!=='tui' and assert the widget content is non-empty / contains the workflow name.
- **truncate() output can exceed the stated max when max < 120** — `format.ts:17-21` _(review)_
  - Fix: Budget the footer against max: const budget = Math.min(max,120); slice to max-budget and omit the footer when it would exceed max. Missing test: truncate(longString, 1).length <= 1 (or footer omitted).
- **Timeline entries render NaN elapsed time when run.startedAt or entry.time is malformed** — `run-view.ts:109,112-115` _(review)_
  - Fix: const started = new Date(run.startedAt).getTime(); const validStarted = Number.isFinite(started) ? started : 0; and similarly guard entry.time, falling back to elapsed 0. Missing test: formatRunView with startedAt='' asserts no 'NaN' in output.
- **appendArtifact uses unguarded fs.appendFile — concurrent agents can interleave/corrupt a shared artifact** — `index.ts:610-617` _(review)_
  - Fix: Extract a general appendFileSafe(filePath, data) in file-append.ts running the write inside runExclusive keyed on path.resolve(filePath), and call it from appendArtifact. Missing test: two concurrent appendArtifact calls to the same name produce a non-interleaved file.
- **notify() silently drops warnings and errors in json/headless mode** — `notify.ts:37-43` _(review)_
  - Fix: After the print branch add: if (!ctx.hasUI) { (type==='info'?console.log:console.error)(message); return; }. Missing test: notify in a non-UI non-print mode with type 'error' writes to stderr.
- **sanitizePersonaOptions copies field values with no type validation** — `agent-env-persona.ts:199-208` _(review)_
  - Fix: Guard array-typed keys: const ARRAY_KEYS=new Set(['tools','excludeTools','skills','extensions','keys']); skip-and-warn when the value is not an array. Missing test: a persona with tools as a string is rejected/skipped with a clear message rather than throwing downstream.
- **Pervasive unit-test gap on the highest-risk pure functions (parsing, path-safety, journal, graph, config)** — `json-extract.ts (whole) / path-safety.ts:1-49 / journal.ts:30-174 / graph-parse.ts:1-324 / config.ts:23-74` _(review)_
  - Fix: Add small fast unit suites (these double as the characterization tests named in findings #1,#2,#17,#18,#19): tests/unit/json-extract (direct/fenced/first-broken/think-block/empty/nested), tests/integration/path-safety (mkdtemp sandbox: in-root ok, ../ throws, absolute throws, pre
- **config.normalizeWorkflowInput passes number/boolean/array primitives through unchanged as workflow input** — `config.ts:47` _(loop-1)_
  - Fix: Treat non-object, non-string inputs as either an error or wrap them: `if (input && typeof input === 'object') return input; if (typeof input === 'string') return parseCliJsonOrText(input); return {}` (or throw with a clear message). Test: normalizeWorkflowInput(42) returns {} (or
- **self-refine refine step has no null guard — a dead/skipped refiner silently replaces the last good draft with null** — `scaffolds/self-refine.js:229-236` _(loop-1)_
  - Fix: After line 236, add: ``if (draft == null) { failureNote = `round ${round}: refine returned null`; log(`self-refine ${failureNote} — returning last good draft`); draft = <captured previous>; break; }`` — capture the pre-refine draft so the last good attempt is returned. Test: stub t
- **guardrails: protect.args=null with no content evaluates the literal string 'null' against input rules** — `scaffolds/guardrails.js:203` _(loop-1)_
  - Fix: Guard the no-input case before runGuards: `const toGuard = content ?? protect.args; if (toGuard == null) { log('guardrails: no content/args to guard — failing closed'); return { status:'TRIPPED', stage:'input', reason:'no input' } }`. Test: call wrapper mode with {} (no content,
- **nextOcc() called after two awaits — occ assignment ordering depends on I/O timing, threatening resume cache correctness** — `index.ts:713-714, 729` _(loop-1)_
  - Fix: Compute key and call nextOcc(key) synchronously at the top of runSubagent, before the two awaits, then carry occ through. Also fix the now-false comment. Test: two concurrent agent() calls with identical args, with applyPersonaOptions artificially delayed on one, must still produ
- **process-spawn: abort listener registered after spawn() — pre-fired abort never kills the child** — `process-spawn.ts:103-115` _(loop-1)_
  - Fix: Immediately after registering the listener (or before spawn), add `if (options.signal.aborted) { kill(); }`. Test: pass an already-aborted signal and assert the child receives SIGTERM promptly rather than waiting for timeoutMs.
- **stableStringify encodes NaN/Infinity/undefined/function/symbol all as 'null' — cache-key collisions across distinct args** — `journal.ts:35,39` _(loop-1)_
  - Fix: Encode non-finite numbers and undefined/function/symbol with a distinct sentinel that cannot collide with JSON null, e.g. return JSON-escaped tokens like `'"__nan__"'`, `'"__undefined__"'`. Test: computeCallKey('agent',[{a:NaN}]) !== computeCallKey('agent',[{a:null}]).
- **active.promise assigned after two awaits — abortActiveWorkflowRuns can read undefined and skip the graceful drain** — `pi-dynamic-workflows/run-lifecycle.ts:135-197` _(loop-2)_
  - Fix: Assign active.promise before the first await, or construct the promise synchronously and store it into active at creation (line 128-134) so the map entry is never observable without its promise. Missing test: invoke abort during the writeRunStatus await and assert the run's promi
- **Workflow log messages can spoof agent-monitor state via the `agent N start:` regex in event-parser** — `pi-dynamic-workflows/event-parser.ts:198-218` _(loop-2)_
  - Fix: Stop overloading free-text log messages as the structural channel. Drive monitor state from the dedicated {type:"agent"} events (already emitted at index.ts:815) rather than regex-parsing log strings, or tag host structural logs with a reserved field (e.g. details.__hostAgentEven
- **Dashboard monitorRunIndex omitted from DashboardSelection — focused run resets to 0 on every reopen** — `pi-dynamic-workflows/workflow-dashboard.ts:67-76, 138-149` _(loop-2)_
  - Fix: Add monitorRunIndex to the DashboardSelection interface, return it from getSelection(), and clamp-restore it in the constructor against monitorModels.length (mirroring the monitorAgentIndex handling at 133-134). Missing test: open dashboard, cycle to monitor run index 2, perform
- **liveWriteTail .catch(()=>{}) silently discards all live stdout/stderr write errors** — `pi-dynamic-workflows/index.ts:813` _(loop-2)_
  - Fix: Capture the first write error into a run-scoped flag and surface it once (a single log/appendEvent at agent end: "live log truncated: <err>") instead of fully swallowing. Keep the chain from rejecting, but record that the artifact is incomplete. Missing test: stub fs.appendFile t

## LOW

- **action=write persists workflow source with no structural validation; invalid code fails only at run time** — `command-handlers.ts:149-158` _(review)_
  - Fix: In the write branch, run transformWorkflowCode(params.code) (discard result) before writing so structural errors surface at write time with the same message, and reject empty/whitespace-only code. On-disk file stays the original source. Missing test: write with a static import as
- **Template-literal ${...} interpolations are treated as string content by the graph tokenizer** — `graph-parse.ts:59-63` _(review)_
  - Fix: Track ${...}: on '$'+'{' while in backtick, push the quote and enter code mode with a brace-depth counter; on the matching } restore the quote. Smallest alternative: emit a warning symbol when a call falls inside a template expression. Missing test: graph-parse unit test assertin
- **countTopLevelArrayItems returns count=1 for spread-only arrays like [...items]** — `graph-parse.ts:208-213` _(review)_
  - Fix: Before returning, if any element trimStart().startsWith('...'), return undefined so inference falls through to the heuristic many:true path. One-line guard. Missing test: countTopLevelArrayItems('[...items]') === undefined.
- **looksLikeJson throws on number-prefixed plain text like '1 agent per team'** — `config.ts:23-24` _(review)_
  - Fix: Remove the digit branch from looksLikeJson (let numeric-looking plain text fall through to {text:value}), or require a full JSON-number match against the whole value. Missing test: parseCliJsonOrText('1 agent per team') returns {text:...} rather than throwing.
- **background tool parameter is in the schema but never read in dispatch** — `command-handlers.ts:172-199 (schema index.ts:288-293)` _(review)_
  - Fix: Either drop background from workflowToolSchema, or wire it through (allow params.background===false to bypass background when the session can run foreground). Do not change the background-by-default behavior; just make the parameter honest.
- **tournament: zero entrants (all seeds crashed) returns empty string with a misleading 'only one entrant' log** — `scaffolds/tournament.js:121-123` _(loop-1)_
  - Fix: Branch length 0 vs 1: `if (entrants.length === 0) { log('tournament: all seeds failed — no entrants'); return { winner:'', failure:'no entrants' } }` (or throw). Test: stub all seed agents to return null and assert an explicit failure rather than a silent empty string.
- **compact() trailer understates truncated char count by 120** — `worker-source.ts:35` _(loop-1)_
  - Fix: Report the actual removed count: `+ (text.length - (maxChars - 120)) + ' chars]'`. Test: compact(str-of-len-N, M) trailer reports N-(M-120).
- **extractFirstStringLiteral leaks raw ${...} template interpolation into graph node labels** — `pi-dynamic-workflows/graph-parse.ts:30` _(loop-2)_
  - Fix: Make the backtick branch consistent with line 36: change `[^`]` to `[^`$]` so interpolated templates are not captured (the function then falls through / returns undefined for those). Missing test: extractFirstStringLiteral("`Hello ${x}`") should not return a string containing `${
- **stableStringify emits non-JSON for sparse arrays (holes render as empty, not null), corrupting call-key reproducibility** — `pi-dynamic-workflows/journal.ts:40-45` _(loop-2)_
  - Fix: Normalize holes in the array branch: `current.map(item => encode(item))` already visits holes-as-undefined if you use a length-based loop. Replace with `Array.from({length: current.length}, (_, i) => encode(current[i]))` so holes encode as "null" (matching JSON.stringify). Missin
- **Falsy coercion (`Number(x)||default`) silently ignores an explicit 0 for quietRounds/maxRounds/finders (and maxVerify)** — `pi-dynamic-workflows/scaffolds/loop-until-dry.js:100,103,106; adversarial-verify.js:143` _(loop-2)_
  - Fix: Replace each `Number(x)||d` with `Number.isFinite(+x) ? Math.floor(+x) : d` so an explicit 0 is honored and then clamped visibly. Missing test: passing {quietRounds:0} logs a clamp 0->1, not a silent default of 2.
- **journal occ accepted as any number (NaN/Infinity/huge float) and used directly as an array index** — `pi-dynamic-workflows/journal.ts:108-110` _(loop-2)_
  - Fix: Tighten the guard to `Number.isInteger(record.occ) && record.occ >= 0 && record.occ < SAFE_MAX` (a bounded cap) and skip otherwise, mirroring the torn-line tolerance already in loadJournal. Missing test: loadJournal of a journal line with occ:1e9 or occ:NaN skips the record and w
