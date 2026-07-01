#!/usr/bin/env node
// build-workflow-artifact.mjs — THIN CLI wrapper around the reusable lib/artifact.mjs module.
// Usage: node build-workflow-artifact.mjs <workflow.js> <out.html> [argsJson]
//                                         [--run <dir|latest>] [--match <s>] [--watch] [--open] [--interval <ms>]
//
// Renders a self-contained, Claude-styled, tabbed HTML preview of ANY dynamic-workflow script
// (Diagram · Agents & prompts · Schemas · Based on · Full script · Results) — BEFORE launching it,
// and (with --run) after/while it runs, overlaying the real run's per-role results. The actual
// build is done by buildArtifact() in ./lib/artifact.mjs (importable from other code); this file
// only does CLI arg parsing, the --watch loop, file writing, and --open. The visualization is
// split by responsibility across lib/: extract.mjs (stubbed-run extraction), run-merge.mjs (run
// ingestion + overlay), render.mjs (data -> HTML), artifact.mjs (orchestrator), plus the already
// modular json-to-markdown.mjs and artifact-client.js inlined into the HTML.
import { writeFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { buildArtifact, resolveRunDir } from "./lib/artifact.mjs";

// ── CLI: <workflow.js> <out.html> [argsJson] plus optional flags ─────────────────────────
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (key === "watch" || key === "open") flags[key] = true;
    else { const nxt = argv[i + 1]; flags[key] = nxt && !nxt.startsWith("--") ? argv[++i] : true; }
  } else pos.push(a);
}
const scriptPath = pos[0];
const outPath = pos[1];
const argsJson = pos[2];
if (!scriptPath || !outPath) { console.error("usage: build-workflow-artifact.mjs <workflow.js> <out.html> [argsJson] [--run <dir|latest>] [--match <s>] [--watch] [--open] [--interval <ms>]"); process.exit(2); }

// ── main: single render, or --watch loop; --open opens now and re-opens when the run ends ─
const openHtml = () => { if (flags.open) execFile("open", [outPath], () => {}); };
const runDir = resolveRunDir(flags.run, flags.match);
if (flags.run && !runDir) console.error("warn: --run given but no run dir resolved for:", flags.run);

const render = async () => {
  const r = await buildArtifact({ scriptPath, argsJson, runDir });
  writeFileSync(outPath, r.html);
  return r;
};

if (flags.watch && runDir) {
  const interval = Math.max(300, parseInt(flags.interval, 10) || 1500);
  let lastMtime = -1;
  let opened = false;
  const tick = async () => {
    let m = 0; try { m = statSync(join(runDir, "status.json")).mtimeMs; } catch {}
    if (m !== lastMtime) {
      lastMtime = m;
      const r = await render();
      const rd = r.runData;
      console.log("rendered", outPath, "· run", rd.state, "·", rd.agentCount, "agents", r.nodeCount, "node types" + (rd.fail ? " · " + rd.fail + " failed" : ""));
      if (!opened) { openHtml(); opened = true; }
      if (!rd.active) { openHtml(); console.log("run terminal (" + rd.state + ") — final render written"); return; }
    }
    setTimeout(tick, interval);
  };
  tick();
} else {
  const r = await render();
  const rd = r.runData;
  console.log("wrote", outPath, "(" + r.nodeCount + " node types, " + r.composes.length + " composes" + (rd ? ", run " + rd.state + ", " + rd.agentCount + " agents" + (rd.fail ? ", " + rd.fail + " failed" : "") : "") + (r.runErr ? ", PARTIAL: " + r.runErr.message : "") + ")");
  openHtml();
}
