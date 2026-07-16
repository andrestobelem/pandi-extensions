#!/usr/bin/env node
// build-workflow-artifact.mjs — envoltorio fino de CLI alrededor del módulo reutilizable lib/artifact.mjs.
// Uso: node build-workflow-artifact.mjs <workflow.js> <out.html> [argsJson]
//                                       [--eval-preview] [--run <dir|latest>] [--match <s>]
//                                       [--watch] [--open] [--interval <ms>]
//
// Renderiza el run report/preview HTML autocontenido de CUALQUIER script dynamic-workflow —
// ANTES de lanzarlo (vista "planned": agentes, schemas, script) y (con --run) durante o después
// del run. Desde la unificación pi/Claude el HTML lo genera el renderer CANÓNICO de pi
// (lib/observe-core.mjs, bundle generado de observe/html.ts): misma feature, mismo código, en
// ambas plataformas. El build real lo hace buildArtifact() en ./lib/artifact.mjs (importable);
// este archivo solo resuelve el parseo de args de CLI, el loop de --watch, la escritura y --open.
// La lib se separa por responsabilidad: extract.mjs (parse-only o evaluación con opt-in),
// run-merge.mjs (ingesta pi/Claude/live-journal), report-model.mjs (adapter al RunReportModel).
import { writeFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, basename } from "node:path";
import { buildArtifact, resolveRunDir } from "./lib/artifact.mjs";

// ── CLI: <workflow.js> <out.html> [argsJson] más flags opcionales ─────────────────────────
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

// ── main: render único, o loop de --watch; --open abre ahora y vuelve a abrir cuando termina el run ─
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
  // Señal de cambio: el máximo mtime entre status.json (runs pi), journal.jsonl (runs de Claude
  // Code en vivo) y el propio dir (aparición del record/archivos nuevos). Solo status.json dejaba
  // los runs de Claude congelados en el primer render.
  // El record de completion vive en el sessionDir hermano (subagents/workflows/wf_x -> workflows/
  // wf_x.json) y se escribe DESPUÉS del último write del journal — sin mirarlo, el watch se
  // quedaría con la vista live para siempre.
  const recordPath = join(runDir, "..", "..", "..", "workflows", basename(runDir) + ".json");
  const changeSignal = () => {
    let max = 0;
    for (const p of [join(runDir, "status.json"), join(runDir, "journal.jsonl"), recordPath, runDir]) {
      try { max = Math.max(max, statSync(p).mtimeMs); } catch {}
    }
    return max;
  };
  const tick = async () => {
    const m = changeSignal();
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
