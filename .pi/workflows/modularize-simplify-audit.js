// Reusable READ-ONLY modularize + simplify audit for the pi-dynamic-workflows
// monorepo (and similar Pi-extension TS repos).
//
// Promoted from drafts/modularize-simplify-audit.js. Difference vs the draft:
// instead of hardcoding today's LOC numbers and index.ts line ranges (which go
// stale the moment you start refactoring), it SCOUTS the current largest source
// files dynamically and builds the auditor work-list from that — so it stays
// correct over time.
//
// Output: one ranked catalog of modularization+simplification opportunities,
// each with file:line evidence, category, lens, impact/effort/risk, a
// behavior-preserving flag, and a proposed sibling module; plus a decomposition
// plan for the largest file(s) and a "first 3 surgical steps" shortlist.
//
// Pattern: scout (ctx.bash) -> fan-out-and-synthesize. One read-only auditor per
// large file; files above a "huge" threshold are split into line-range
// sub-chunks (the long pole); remaining small files get one cross-cutting sweep.
// NO file edits — auditors get read/grep/find/ls only. Run in background with
// explicit concurrency/maxAgents and inspect artifacts before trusting it.
//
// Input (all optional):
//   { concurrency, scope, largeFileThreshold, hugeFileThreshold, chunkLoc,
//     maxLargeUnits, includeTests, agentTimeoutMs }
//   scope: glob/dir passed to git ls-files (default "extensions").

function chooseConcurrency(ctx, input, count) {
  const requested = Number.isFinite(input?.concurrency) ? Math.floor(input.concurrency) : 5;
  return Math.min(Math.max(requested, 1), ctx.limits.concurrency, Math.max(1, count));
}

// Shared finding schema for every auditor unit.
const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unit", "filesAssessed", "findings", "proposedModules"],
  properties: {
    unit: { type: "string" },
    filesAssessed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "verdict"],
        properties: {
          file: { type: "string" },
          verdict: { type: "string" }, // one-line: opportunity found | already clean
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "extension", "file", "lineRange", "category", "lens",
          "evidence", "impact", "effort", "risk", "behaviorPreserving",
          "rationale", "proposedModule",
        ],
        properties: {
          id: { type: "string" },
          extension: { type: "string" },
          file: { type: "string" },
          lineRange: { type: "string" }, // e.g. "2199-3486"
          category: { type: "string", enum: ["split", "extract", "dedupe", "simplify"] },
          lens: { type: "string", enum: ["modularize", "simplify"] },
          evidence: { type: "string" }, // concrete: symbol names / smell + why
          impact: { type: "string", enum: ["high", "med", "low"] },
          effort: { type: "string", enum: ["high", "med", "low"] },
          risk: { type: "string", enum: ["high", "med", "low"] },
          behaviorPreserving: { type: "boolean" },
          rationale: { type: "string" },
          proposedModule: { type: "string" }, // target sibling file or "n/a"
        },
      },
    },
    // Large-file auditors populate this with candidate sibling modules.
    proposedModules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "responsibility", "symbolsToMove", "roughLoc"],
        properties: {
          name: { type: "string" }, // e.g. "dashboard.ts"
          responsibility: { type: "string" },
          symbolsToMove: { type: "array", items: { type: "string" } },
          roughLoc: { type: "number" },
        },
      },
    },
  },
};

const IDIOM = `REPO MODULE IDIOM (follow this; do NOT invent new frameworks):
- This repo already splits cohesive concerns into small sibling files next to a
  thin index.ts. In pi-dynamic-workflows: agent-env-persona.ts, agent-output.ts,
  concurrency-primitives.ts, config.ts, event-parser.ts, format.ts,
  graph-parse.ts, journal.ts, json-extract.ts, notify.ts, presentation.ts,
  process-spawn.ts, render-utils.ts, run-state.ts, run-store.ts, run-view.ts,
  structured-output.ts, templates.ts, worker-source.ts. index.ts re-exports many
  of them, so the public surface stays stable across an extraction.
- pi-loop similarly splits gate.ts/caps.ts/interval.ts/status.ts/prompt.ts/etc.
- ESM/NodeNext: relative imports MUST use explicit ".js" extensions.
- Behavior MUST be preserved: tests/<extension>/integration is the behavior
  contract; the public extension surface (default export, registered
  commands/tools, named exports relied on by tests) must stay identical. A good
  extraction is a mechanical move + re-export, no logic change.`;

const RULES = `RULES:
- READ-ONLY. Do NOT edit, move, or create files. Use read/grep/find/ls only.
- Cite real file:line ranges and real symbol names — never invent paths/APIs.
- For dedupe findings, cite >=2 grep-able locations in the evidence.
- behaviorPreserving=true ONLY for a pure mechanical move/extraction with no
  logic/behavior/API change; otherwise false.
- Rate impact/effort/risk honestly. Prefer high-impact + low-effort + low-risk.
- Do NOT propose cosmetic renames, speculative abstraction, formatting/lint fixes,
  dependency changes, or behavior/feature changes (out of scope).
- Be concrete and concise. Every finding must be independently verifiable.`;

function buildLineChunks(loc, chunkLoc) {
  const n = Math.max(1, Math.ceil(loc / chunkLoc));
  const size = Math.ceil(loc / n);
  const ranges = [];
  for (let i = 0; i < n; i++) {
    const start = i * size + 1;
    const end = Math.min(loc, (i + 1) * size);
    if (start > loc) break;
    ranges.push([start, end]);
  }
  return ranges;
}

function extOf(file) {
  // extensions/<name>/... -> <name>; else top-level dir.
  const m = file.match(/^extensions\/([^/]+)\//);
  if (m) return m[1];
  const parts = file.split("/");
  return parts.length > 1 ? parts[0] : file;
}

module.exports = async function workflow(ctx, input) {
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  const scope = typeof input?.scope === "string" && input.scope ? input.scope : "extensions";
  const largeThreshold = Number.isFinite(input?.largeFileThreshold) ? Math.floor(input.largeFileThreshold) : 600;
  const hugeThreshold = Number.isFinite(input?.hugeFileThreshold) ? Math.floor(input.hugeFileThreshold) : 2400;
  const chunkLoc = Number.isFinite(input?.chunkLoc) ? Math.floor(input.chunkLoc) : 2200;
  const maxLargeUnits = Number.isFinite(input?.maxLargeUnits) ? Math.floor(input.maxLargeUnits) : 16;
  const includeTests = input?.includeTests === true;

  // ---- Scout: discover current source files + LOC (cached for cheap resume) ----
  const testFilter = includeTests ? "cat" : "grep -vE '/tests/|\\.test\\.|\\.spec\\.'";
  const scoutCmd =
    `git ls-files '${scope}/**/*.ts' '${scope}/**/*.mjs' '${scope}/**/*.js' 2>/dev/null ` +
    `| ${testFilter} ` +
    `| while IFS= read -r f; do n=$(wc -l < "$f" 2>/dev/null | tr -d ' '); printf '%s\\t%s\\n' "$n" "$f"; done ` +
    `| sort -rn`;
  const scout = await ctx.bash(scoutCmd, { cache: true });
  const rows = String(scout.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf("\t");
      const loc = parseInt(l.slice(0, tab), 10);
      const file = l.slice(tab + 1).trim();
      return { loc: Number.isFinite(loc) ? loc : 0, file };
    })
    .filter((r) => r.file);

  if (rows.length === 0) {
    await ctx.log("scout found no source files", { scope, includeTests });
    return { error: `No source files found under scope "${scope}".`, findings: 0 };
  }

  let largeFiles = rows.filter((r) => r.loc >= largeThreshold).sort((a, b) => b.loc - a.loc);
  const smallFiles = rows.filter((r) => r.loc < largeThreshold);

  // Clamp the number of large-file units; log anything dropped (never silent).
  let droppedLarge = [];
  if (largeFiles.length > maxLargeUnits) {
    droppedLarge = largeFiles.slice(maxLargeUnits);
    largeFiles = largeFiles.slice(0, maxLargeUnits);
  }

  const locTable = rows
    .filter((r) => r.loc >= largeThreshold)
    .map((r) => `  ${String(r.loc).padStart(6)}  ${r.file}`)
    .join("\n");

  // ---- Build the auditor work-list dynamically ----
  const units = [];
  for (const lf of largeFiles) {
    if (lf.loc >= hugeThreshold) {
      const ranges = buildLineChunks(lf.loc, chunkLoc);
      ranges.forEach(([start, end], i) => {
        units.push({
          name: `${extOf(lf.file)}-chunk${i + 1}`,
          isLargeFile: true,
          focus:
            `${lf.file} LINES ${start}-${end} ONLY (file is ${lf.loc} LOC, split into ${ranges.length} chunks; ` +
            `you are chunk ${i + 1}/${ranges.length}). FIRST grep top-level declarations ` +
            `(^export |^function |^async function |^class |^const |^type |^interface ) within your range to map ` +
            `cohesive clusters of symbols. Identify clusters that should become sibling modules and any local ` +
            `simplifications. POPULATE proposedModules with candidate sibling files for YOUR line-range only ` +
            `(name, responsibility, symbolsToMove, roughLoc).`,
        });
      });
    } else {
      units.push({
        name: extOf(lf.file) === lf.file ? lf.file.replace(/[^a-z0-9]+/gi, "-") : `${extOf(lf.file)}-${lf.file.split("/").pop()}`,
        isLargeFile: true,
        focus:
          `${lf.file} (${lf.loc} LOC). Map its top-level declarations, find cohesive clusters that should become ` +
          `sibling modules (category "split"/"extract") and local simplifications/dedupe. Give a one-line verdict ` +
          `for the file. POPULATE proposedModules with candidate sibling files (name, responsibility, symbolsToMove, roughLoc).`,
      });
    }
  }

  // One cross-cutting sweep over the remaining small files (+ cross-extension dup).
  if (smallFiles.length > 0) {
    const smallList = smallFiles.map((r) => `${r.file} (${r.loc})`).join(", ");
    units.push({
      name: "small-files-and-cross-cutting-sweep",
      isLargeFile: false,
      focus:
        `Sweep the remaining smaller source files for modularization/simplification AND cross-file/cross-extension ` +
        `DUPLICATION. Files (path (LOC)): ${smallList}. Give a one-line verdict per file you assess; cite >=2 ` +
        `locations for any duplication finding. Look especially for duplicated helpers that could live in a shared module.`,
    });
  }

  const concurrency = chooseConcurrency(ctx, input, units.length);
  await ctx.log("audit fan-out selected", {
    scope,
    sourceFiles: rows.length,
    largeFiles: largeFiles.length,
    smallFiles: smallFiles.length,
    units: units.length,
    thresholds: { largeThreshold, hugeThreshold, chunkLoc, maxLargeUnits },
    requestedConcurrency: Number.isFinite(input?.concurrency) ? Math.floor(input.concurrency) : 5,
    effectiveConcurrency: concurrency,
    maxAgents: ctx.limits.maxAgents,
    droppedLargeFiles: droppedLarge.map((r) => `${r.file} (${r.loc})`),
    note: droppedLarge.length
      ? `CAP: ${droppedLarge.length} large file(s) over maxLargeUnits were NOT given a dedicated auditor (listed in droppedLargeFiles).`
      : "No coverage cap; one read-only auditor per large file, huge files split by line range.",
  });
  await ctx.writeArtifact("scout-loc-table.txt", `# Source files >= ${largeThreshold} LOC (scope: ${scope})\n${locTable}\n`);

  const unitPrompt = (unit, index) => `You are an INDEPENDENT read-only code auditor for the Pi Dynamic Workflows monorepo (TypeScript, ESM/NodeNext).

Mission: find concrete MODULARIZATION and SIMPLIFICATION opportunities in your assigned scope. This is a read-only audit that feeds a prioritized refactor plan — you do NOT edit anything.

Your unit: "${unit.name}" (auditor ${index + 1}/${units.length}).
Scope/focus: ${unit.focus}

Current source files >= ${largeThreshold} LOC (for context; ranked):
${locTable}

${IDIOM}

${RULES}

Method:
1. Inspect your assigned files/line-ranges with read/grep/find/ls. Confirm real LOC and real symbol names.
2. modularization (lens="modularize"): find oversized files and cohesive clusters of symbols that should become a sibling module (category "split" for whole-file decomposition, "extract" for a cohesive unit). Name the proposedModule sibling file.
3. simplification (lens="simplify"): find duplicated logic (category "dedupe", cite >=2 locations), dead/unused code, or needlessly complex control flow (category "simplify").
4. Rate impact/effort/risk and set behaviorPreserving. Give a one-line verdict per file you assessed (opportunity found | already clean).
5. ${unit.isLargeFile ? "POPULATE proposedModules with the candidate sibling files for your scope (name, responsibility, symbolsToMove, roughLoc)." : "Leave proposedModules as [] unless a small file clearly warrants its own split."}

Return JSON matching the schema EXACTLY. Use stable ids like "${unit.name}-1", "${unit.name}-2". If you find nothing in scope, return empty findings but still fill filesAssessed verdicts.`;

  const results = await ctx.agents(
    units.map((unit, index) => ({
      name: unit.name,
      prompt: unitPrompt(unit, index),
      tools: ["read", "grep", "find", "ls"],
      includeExtensions: false, // pure read-only static audit; no web needed
      agentType: "reviewer",
      thinking: "medium",
      schema: findingSchema,
      schemaRetries: 2,
      schemaOnInvalid: "null",
      timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
    })),
    { concurrency, settle: true },
  );

  const completed = results
    .map((r, i) => ({ r, unit: units[i].name }))
    .filter((x) => x.r && x.r.schemaOk && x.r.data);
  const failedUnits = results
    .map((r, i) => ({ ok: !!(r && r.schemaOk && r.data), unit: units[i].name }))
    .filter((x) => !x.ok)
    .map((x) => x.unit);

  const allFindings = completed.flatMap((x) => x.r.data.findings || []);
  const allModules = completed.flatMap((x) =>
    (x.r.data.proposedModules || []).map((m) => ({ ...m, fromUnit: x.unit })),
  );
  const coverage = completed.flatMap((x) =>
    (x.r.data.filesAssessed || []).map((f) => ({ ...f, unit: x.unit })),
  );

  await ctx.log("auditors complete", {
    total: results.length,
    completed: completed.length,
    failedUnits,
    findings: allFindings.length,
    proposedModules: allModules.length,
    filesAssessed: coverage.length,
  });
  await ctx.writeArtifact("raw-findings.json", { findings: allFindings, proposedModules: allModules, coverage, failedUnits, droppedLarge });

  const largestFile = largeFiles[0]?.file || "(the largest source file)";

  const synthesis = await ctx.agent(
    `You are the SYNTHESIS JUDGE producing the final modularize+simplify audit report for the pi-dynamic-workflows monorepo.

You receive findings from ${units.length} independent read-only auditors. ${failedUnits.length ? `FAILED/INVALID units (their scope is NOT covered — say so explicitly in a Coverage Gaps section): ${failedUnits.join(", ")}.` : "All units returned valid output."}${droppedLarge.length ? ` NOTE: ${droppedLarge.length} large file(s) exceeded the maxLargeUnits cap and were NOT audited: ${droppedLarge.map((r) => `${r.file} (${r.loc})`).join(", ")} — list these under Coverage Gaps.` : ""}

${IDIOM}

Your job (synthesis-as-judge, do NOT invent findings — only use evidence below):
1. DEDUPE and NORMALIZE findings across units; drop anything without concrete file:line evidence or that is actually formatting/lint/behavior-change scope.
2. Produce a RANKED CATALOG ordered by impact-vs-effort-vs-risk (high impact + low effort + low risk first). Keep each finding's file:line, category, lens, ratings, behaviorPreserving flag, and proposedModule. Group into tiers.
3. Produce a DECOMPOSITION PLAN for the largest file (${largestFile}) and any other file with >=3 proposedModules: merge the candidate sibling modules, each with responsibility, key symbols to move, rough LOC, and an acyclic import seam; cite a REAL existing sibling module as the pattern (e.g. graph-parse.ts, run-state.ts, run-view.ts). Note how index.ts re-exports keep the public API stable.
4. Produce a "FIRST 3 SURGICAL STEPS" shortlist: the lowest-risk, highest-leverage, behavior-preserving extractions to seed an incremental follow-up.
5. Produce a COVERAGE table: per extension/file, a one-line verdict (opportunity found / already clean / NOT covered). List any cap, truncation, dropped large file, or skipped WIP.
6. State the VERIFICATION SIGNAL that would guard any eventual edit: npm run typecheck + npm run test:integration green (and full npm test), public extension surface unchanged.

Write the report in clear English Markdown with these sections in order:
# Modularize & Simplify Audit — pi-dynamic-workflows
## TL;DR (top 5 opportunities, one line each)
## Ranked Catalog (tiered; table or list with file:line, category, lens, impact/effort/risk, behaviorPreserving, proposedModule)
## Decomposition Plan (largest file first)
## First 3 Surgical Steps
## Coverage
## Verification Signal & Non-Goals
## Coverage Gaps / Failed Units

Auditor coverage: requested ${units.length}, valid ${completed.length}, failed/invalid ${failedUnits.length}.

RAW FINDINGS (JSON):
${ctx.compact(allFindings, 60000)}

PROPOSED MODULES (JSON):
${ctx.compact(allModules, 15000)}

PER-FILE COVERAGE VERDICTS (JSON):
${ctx.compact(coverage, 15000)}

Return ONLY the final Markdown report.`,
    {
      name: "audit-synthesis",
      tools: ["read", "grep", "find", "ls"],
      includeExtensions: false,
      agentType: "reviewer",
      thinking: "high",
      timeoutMs: input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs,
    },
  );

  const report = synthesis.text || synthesis.output || "(no report text returned)";
  await ctx.writeArtifact("modularize-simplify-audit.md", report);
  await ctx.log("audit synthesis done", {
    reportChars: report.length,
    findings: allFindings.length,
    failedUnits,
    droppedLargeFiles: droppedLarge.length,
  });

  return {
    scope,
    sourceFiles: rows.length,
    largeFiles: largeFiles.length,
    units: units.length,
    findings: allFindings.length,
    proposedModules: allModules.length,
    failedUnits,
    droppedLargeFiles: droppedLarge.map((r) => r.file),
    reportArtifact: "modularize-simplify-audit.md",
  };
};
