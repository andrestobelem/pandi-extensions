#!/usr/bin/env node
// build-workflow-artifact.mjs — compatibility CLI for the project-local .pi path.
// The maintained renderer lives under .claude/scripts/lib so the pre-launch preview and
// post-run overlay share one Pandi-styled HTML implementation.
// Usage: node build-workflow-artifact.mjs <workflow.js> <out.html> [argsJson]
//                                         [--eval-preview] [--run <dir|latest>] [--match <s>]
//                                         [--watch] [--open] [--interval <ms>]
import { writeFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { buildArtifact, resolveRunDir } from "../../.claude/scripts/lib/artifact.mjs";

const usage = "usage: build-workflow-artifact.mjs <workflow.js> <out.html> [argsJson] [--eval-preview] [--run <dir|latest>] [--match <s>] [--watch] [--open] [--interval <ms>]";
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (key === "watch" || key === "open" || key === "eval-preview" || key === "help") flags[key] = true;
    else { const nxt = argv[i + 1]; flags[key] = nxt && !nxt.startsWith("--") ? argv[++i] : true; }
  } else pos.push(a);
}
if (flags.help) {
	console.log(usage);
	console.log("  --eval-preview  evalúa explícitamente el workflow con runtime stubs; el default es parse-only");
	process.exit(0);
}
const scriptPath = pos[0];
const outPath = pos[1];
const argsJson = pos[2];
if (!scriptPath || !outPath) { console.error(usage); process.exit(2); }

const openHtml = () => { if (flags.open) execFile("open", [outPath], () => {}); };
const runDir = resolveRunDir(flags.run, flags.match);
if (flags.run && !runDir) console.error("warn: --run given but no run dir resolved for:", flags.run);

const render = async () => {
  const r = await buildArtifact({ scriptPath, argsJson, runDir, evalPreview: flags["eval-preview"] === true });
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
