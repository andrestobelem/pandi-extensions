// render.mjs — assemble the data object (mermaid + fidelity notes + everything the client needs)
// and produce the self-contained HTML string. Pure: no file IO, no process state.
import { phaseTitleOf } from "./util.mjs";

// Detect a Contract Gate result to show in a dedicated Contract tab: the run's return value (or a
// contract.json artifact) that carries the contract shape. Field names tolerate both this repo's
// lean gate (routingHints/blockers) and the full contract-gate scaffold (routingHint/ambiguities);
// the client renderer normalizes them. Returns null when no contract is present (byte-identical path).
const looksLikeContract = (o) => !!o && typeof o === "object" && typeof o.improvedTask === "string" && Array.isArray(o.successCriteria);
function detectContract(runData) {
  if (!runData || !runData.results) return null;
  if (looksLikeContract(runData.results.returnValue)) return runData.results.returnValue;
  const cj = (runData.results.artifacts || []).find((a) => a.ext === "json" && /contract/i.test(a.name));
  if (cj) { try { const o = JSON.parse(cj.content); if (looksLikeContract(o)) return o; } catch { /* not a contract */ } }
  return null;
}
const mmId = (s) => "P" + String(s).replace(/[^A-Za-z0-9]/g, "_");
const mmLabel = (s) => String(s).replace(/["\[\]{}|<>`$]/g, " ").replace(/\s+/g, " ").trim();
const shortModel = (m) => (m && m !== "inherited" ? String(m).split("/").pop() : null);
const nodeME = (n) => [shortModel(n.model), n.effort && n.effort !== "inherited" ? n.effort : null].filter(Boolean).join("/");

// Assemble { html, data } from the static model + merged nodes + (optional) run data.
export function assembleArtifact({ merged, basePhases, composes, meta, provenance, scaffolds, scriptPath, argsJson, schemas, skillRefs, raw, runData, staticFidelity, jsonToMarkdownSource, clientJsSource, contractViewSource }) {
  const nodes = merged.nodes;
  const phases = [...basePhases, ...merged.extraPhases.filter((p) => !basePhases.includes(p))];

  // auto Mermaid: IN -> phase groups in order -> OUT, plus compose edges
  const nodesByPhase = {};
  for (const n of nodes) (nodesByPhase[n.phase] ||= []).push(n);
  // Diagram must show every phase that has nodes — declared phases first, then any extra node
  // phase (e.g. "—" for agents the workflow never tagged with a phase) so nodes are never dropped.
  const nodePhases = Object.keys(nodesByPhase);
  const orderedPhases = [...phases, ...nodePhases.filter((p) => !phases.includes(p))];
  let mm = "flowchart TB\n  IN([args input]):::io\n";
  orderedPhases.forEach((ph) => {
    const ns = nodesByPhase[ph] || [];
    mm += `  subgraph ${mmId(ph)}["${mmLabel(ph)}"]\n   direction LR\n`;
    ns.forEach((n, i) => {
      const me = nodeME(n);
      const glyph = n.run ? (n.run.fail ? ` · ✗${n.run.fail}/${n.run.count}` : n.run.running ? ` · ⏳${n.run.running}` : ` · ✓${n.run.count}`) : "";
      const cls = n.run ? (n.run.fail ? "agf" : n.run.running ? "agr" : "agok") : "ag";
      mm += `   ${mmId(ph)}_${i}["${mmLabel(n.role)}${n.schemaObj ? " · schema" : ""}${me ? " · " + mmLabel(me) : ""}${glyph}"]:::${cls}\n`;
    });
    if (!ns.length) mm += `   ${mmId(ph)}_x["no agents · bash-only or unreached"]:::empty\n`;
    mm += "  end\n";
  });
  let prev = "IN";
  orderedPhases.forEach((ph) => { mm += `  ${prev} --> ${mmId(ph)}\n`; prev = mmId(ph); });
  mm += `  ${prev} --> OUT[/"return"/]:::io\n`;
  composes.forEach((c, i) => { mm += `  COMP${i}{{"workflow ${mmLabel(c)}"}}:::comp\n  ${prev} -. composes .-> COMP${i}\n`; });
  mm += "  classDef io fill:#f3efe7,stroke:#8a877f,color:#1f1e1d;\n  classDef ag fill:#e7f1ea,stroke:#3f7a52,color:#1f3d2a;\n  classDef agok fill:#dcefe1,stroke:#2f7a4a,color:#123421;\n  classDef agr fill:#dbe7f7,stroke:#2f6f9e,color:#1f3350;\n  classDef agf fill:#fbe3da,stroke:#b54545,color:#5c1f13;\n  classDef comp fill:#efe7f6,stroke:#7a4fb0,color:#3a2356;\n  classDef empty fill:#f6f4ee,stroke:#d9d5cc,color:#8a877f;";

  // Fidelity notes — an empty box is never read as "no agents" when it's really runtime-gated.
  const fidelityNotes = [...staticFidelity];
  const declaredPhaseTitles = (meta.phases || []).map(phaseTitleOf).filter(Boolean);
  const emptyDeclared = declaredPhaseTitles.filter((t) => !nodes.some((n) => n.phase === t));
  if (emptyDeclared.length) fidelityNotes.push("declared phase(s) with no recorded agents: " + emptyDeclared.join(", ") + (runData ? " — still gated on runtime values or bash-only (not reached in this run)" : " — likely gated on runtime values; see the Full script tab"));

  const run = runData ? { runId: runData.runId, state: runData.state, active: runData.active, agentCount: runData.agentCount, ok: runData.ok, fail: runData.fail, running: runData.running, elapsedMs: runData.elapsedMs } : null;
  const contract = detectContract(runData);
  const hasContract = !!contract;
  const data = {
    meta, phases, composes, __mm: mm,
    provenance, scaffolds, source: scriptPath,
    args: argsJson ? "(provided)" : "(kitchen-sink defaults for extraction)",
    schemas, nodes, skillRefs, script: raw, run, ...(hasContract ? { contract } : {}),
    results: runData ? runData.results : null,
    warn: fidelityNotes.length ? fidelityNotes.join(" · ") : null,
  };
  const jsonBlob = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const autoRefresh = !!(runData && runData.active);

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${autoRefresh ? '<meta http-equiv="refresh" content="2">' : ""}
<title>${(meta.name || "workflow").replace(/[<>&]/g, "")} — workflow</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css">
<style>
  :root{--bg:#faf9f5;--paper:#fff;--ink:#1f1e1d;--ink2:#52504b;--muted:#8a877f;--line:#e7e4db;--coral:#d97757;--coral-d:#bd5d3f;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif;}
  .container{max-width:980px;margin:0 auto;padding:0 24px 80px;}
  header{padding:40px 0 8px;} header .kicker{font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:var(--coral-d);font-weight:600;}
  header h1{margin:6px 0 6px;font-size:34px;} header p{margin:0;color:var(--ink2);max-width:74ch;}
  .prov{margin:0 0 16px;padding:12px 16px;background:var(--paper);border:1px solid var(--line);border-radius:12px;font-size:16px;color:var(--ink2);} .prov b{color:var(--ink);} .prov a{color:var(--coral-d);} .prov .cite{font-family:ui-monospace,Menlo,monospace;color:var(--muted);} .prov code{font-family:ui-monospace,Menlo,monospace;font-size:14px;color:var(--muted);background:#f3efe7;padding:2px 7px;border-radius:6px;word-break:break-all;}
  .trole{font-size:14px;color:var(--muted);margin-top:2px;} .subh{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:18px 0 10px;}
  .chips{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;} .chip{font-size:14px;padding:4px 10px;border-radius:999px;background:#f3efe7;border:1px solid var(--line);color:var(--ink2);}
  .runbanner{margin:14px 0 4px;padding:10px 14px;border-radius:10px;font-size:15.5px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;} .runbanner b{font-weight:700;}
  .runbanner.ok{background:#eef7f0;border:1px solid #bfe0c8;color:#1f3d2a;} .runbanner.run{background:#eef3fb;border:1px solid #c3d6ef;color:#1f3350;} .runbanner.fail{background:#fdeeea;border:1px solid #f0c1b2;color:#7a2f18;}
  .banner{margin:18px 0 8px;padding:10px 14px;background:#fdf1ec;border:1px solid #f0c9b8;border-radius:10px;color:#8a3f22;font-size:16px;}
  .warn{margin:10px 0;padding:8px 12px;background:#fff7e6;border:1px solid #f0d8a8;border-radius:8px;color:#7a5a14;font-size:15px;}
  nav.tabs{position:sticky;top:0;background:var(--bg);padding:14px 0;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);z-index:5;}
  nav.tabs button{font:inherit;font-size:16px;border:1px solid var(--line);background:var(--paper);color:var(--ink2);padding:7px 14px;border-radius:8px;cursor:pointer;}
  nav.tabs button.active{background:var(--coral);border-color:var(--coral);color:#fff;font-weight:600;}
  section{display:none;padding-top:24px;} section.active{display:block;}
  h2.sec{font-size:15.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 14px;}
  .card{background:var(--paper);border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden;}
  .card>.head{padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;} .card>.head:hover{background:#fbfaf7;}
  .badge{font-size:13px;font-weight:600;padding:3px 9px;border-radius:6px;color:#fff;white-space:nowrap;}
  .rpill{font-size:13px;font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap;} .rpill.ok{background:#dff0e4;color:#1f6b39;border:1px solid #b7ddc3;} .rpill.fail{background:#f7d9d0;color:#8a2f16;border:1px solid #e6b3a3;} .rpill.run{background:#dbe7f7;color:#274a77;border:1px solid #b4cbea;}
  .nid{font-family:ui-monospace,Menlo,monospace;font-size:16px;font-weight:600;} .me{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--ink2);background:#f3efe7;border:1px solid var(--line);padding:2px 8px;border-radius:999px;white-space:nowrap;} .schema{margin-left:auto;font-size:14px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;}
  .card .body{display:none;border-top:1px solid var(--line);} .card.open .body{display:block;}
  .caret{color:var(--muted);transition:transform .15s;} .card.open .caret{transform:rotate(90deg);}
  .meta-row{display:flex;gap:18px;flex-wrap:wrap;padding:12px 16px;background:#fbfaf7;border-bottom:1px solid var(--line);font-size:15px;color:var(--ink2);} .meta-row b{color:var(--ink);}
  .skrow{padding:10px 16px;background:#fbfaf7;border-bottom:1px solid var(--line);font-size:15px;color:var(--ink2);display:flex;gap:6px;align-items:center;flex-wrap:wrap;} .skrow b{color:var(--ink);margin-right:4px;} .skill{font-size:14px;padding:3px 9px;border-radius:6px;background:#e8f0e8;border:1px solid #cfe0cf;color:#2f6b3c;font-family:ui-monospace,Menlo,monospace;}
  .skref{font-size:13px;color:var(--muted);} .skref code{background:#f3efe7;padding:1px 5px;border-radius:4px;font-size:12.5px;} .skmiss{color:#8a2f16;font-size:13px;}
  .card.warn-skills{box-shadow:inset 4px 0 0 #d9822b;} .warnbadge{font-size:12.5px;font-weight:600;padding:3px 8px;border-radius:6px;background:#f7e6cf;color:#8a5314;border:1px solid #e6c48f;white-space:nowrap;}
  .rout{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:14px;line-height:1.55;padding:12px 16px;color:#33312d;background:#f7faf8;border-bottom:1px solid var(--line);} .rout .lbl{display:block;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;} .rart{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--muted);padding:8px 16px;border-bottom:1px solid var(--line);word-break:break-all;}
  .prompt{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:15px;line-height:1.6;padding:16px;color:#33312d;}
  .copy{float:right;font:inherit;font-size:14px;border:1px solid var(--line);background:var(--paper);border-radius:7px;padding:4px 10px;cursor:pointer;color:var(--ink2);}
  pre.block{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto;font-size:15px;} .diagram{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto;}
  .tname{font-family:ui-monospace,Menlo,monospace;font-weight:600;color:var(--coral-d);}
  .mdbody{padding:6px 18px 16px;color:#33312d;font-size:17px;line-height:1.7;} .mdbody h1{font-size:24px;margin:16px 0 8px;} .mdbody h2{font-size:19px;margin:14px 0 6px;} .mdbody h3{font-size:17px;margin:12px 0 6px;} .mdbody ol,.mdbody ul{padding-left:22px;margin:6px 0;} .mdbody li{margin:3px 0;} .mdbody p{margin:8px 0;} .mdbody code{font-family:ui-monospace,Menlo,monospace;font-size:15px;background:#f3efe7;padding:1px 5px;border-radius:5px;} .mdbody pre{background:#faf9f5;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;} .mdbody pre code{background:none;padding:0;} .mdbody a{color:var(--coral-d);} .mdbody blockquote{border-left:3px solid var(--line);margin:8px 0;padding:2px 12px;color:var(--ink2);} .mdbody table{border-collapse:collapse;margin:8px 0;} .mdbody th,.mdbody td{border:1px solid var(--line);padding:5px 10px;}
</style></head><body><div class="container">
  <header><div class="kicker">Dynamic workflow · review before launch</div><h1 id="wf-name"></h1><p id="wf-desc"></p>
  <div class="runbanner" id="runbanner" style="display:none"></div>
  <div class="chips" id="wf-chips"></div>
  <div class="warn" id="warn" style="display:none"></div></header>
  <nav class="tabs" id="tabs">
    <button data-t="overview" class="active">Diagram</button>${hasContract ? '<button data-t="contract">Contract</button>' : ""}<button data-t="agents">Agents &amp; prompts</button>
    <button data-t="schemas">Schemas</button><button data-t="based">Based on</button><button data-t="script">Full script</button><button data-t="results" id="tabresults">Results</button>
  </nav>
  <section data-s="overview" class="active"><h2 class="sec">Orchestration</h2><div class="diagram"><pre class="mermaid" id="mm"></pre></div></section>${hasContract ? '<section data-s="contract"><h2 class="sec">Contract — task contract from the gate</h2><div class="mdbody" id="contract"></div></section>' : ""}
  <section data-s="results"><h2 class="sec">Results — return value &amp; artifacts</h2><div id="results"></div></section>
  <section data-s="agents"><h2 class="sec">Agents — click for the exact composed prompt</h2><div id="agents"></div></section>
  <section data-s="schemas"><h2 class="sec">Structured-output schemas</h2><div id="schemas"></div></section>
  <section data-s="based"><h2 class="sec">Based on — sources &amp; scaffolds</h2><div id="based"></div></section>
  <section data-s="script"><h2 class="sec">Full script</h2><pre class="block"><code class="language-javascript" id="script"></code></pre></section>
</div>
<script type="application/json" id="data">${jsonBlob}</script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
${jsonToMarkdownSource}
${clientJsSource}${hasContract && contractViewSource ? "\n" + contractViewSource : ""}
</script></body></html>`;

  return { html, data, nodeCount: nodes.length };
}
