// render.mjs — arma el objeto data (mermaid + fidelity notes + todo lo que necesita el cliente)
// y produce el string HTML autocontenido. Puro: sin file IO, sin estado de proceso.
import { renderWorkflowMonitor } from "./monitor.mjs";
import { renderWorkflowPlan } from "./plan.mjs";
import { phaseTitleOf } from "./util.mjs";

// Detecta un resultado de Contract Gate para mostrarlo en una tab Contract dedicada: el valor de retorno
// del run (o un artifact contract.json) que trae la forma del contrato. Los nombres de campos toleran tanto
// el gate lean de este repo (routingHints/blockers) como el scaffold contract-gate completo (routingHint/ambiguities);
// el renderer cliente los normaliza. Devuelve null cuando no hay contrato presente (ruta byte-idéntica).
const looksLikeContract = (o) => !!o && typeof o === "object" && typeof o.improvedTask === "string" && Array.isArray(o.successCriteria);
function detectContract(runData) {
  if (!runData || !runData.results) return null;
  if (looksLikeContract(runData.results.returnValue)) return runData.results.returnValue;
  const cj = (runData.results.artifacts || []).find((a) => a.ext === "json" && /contract/i.test(a.name));
  if (cj) { try { const o = JSON.parse(cj.content); if (looksLikeContract(o)) return o; } catch { /* no es un contrato */ } }
  return null;
}
const mmId = (s) => "P" + String(s).replace(/[^A-Za-z0-9]/g, "_");
const mmLabel = (s) => String(s).replace(/["\[\]{}|<>`$]/g, " ").replace(/\s+/g, " ").trim();
const shortModel = (m) => (m && m !== "inherited" ? String(m).split("/").pop() : null);
const nodeME = (n) => [shortModel(n.model), n.effort && n.effort !== "inherited" ? n.effort : null].filter(Boolean).join("/");
const escHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
const plural = (count, singular, pluralForm = `${singular}s`) => (count === 1 ? singular : pluralForm);

function artifactKicker(runData) {
  if (!runData) return "Workflow dinámico · preview estático";
  if (runData.fail > 0) return "Workflow dinámico · reporte de run · con fallas";
  if (runData.active || runData.state === "running") return "Workflow dinámico · run en progreso";
  return "Workflow dinámico · reporte de run";
}

function openingText({ runData, nodeCount, argsJson, hasResults }) {
  if (!runData) {
    const argsLabel = argsJson ? "args provistos" : "args de ejemplo";
    return `Vista estática antes de ejecutar: muestra la estructura extraída con ${argsLabel}. Confirmá fases, prompts y límites antes de lanzar el run.`;
  }
  const total = runData.agentCount || 0;
  const agentLabel = plural(total, "agente");
  const failed = runData.fail || 0;
  const running = runData.running || 0;
  if (failed > 0) {
    const firstStep = hasResults ? "Empezá por Resultados" : "No hay output final registrado; empezá por las tarjetas fallidas";
    return `${failed} de ${total} ${agentLabel} falló${failed === 1 ? "" : "n"}. ${firstStep}; después abrí prompts y evidencia cruda.`;
  }
  if (runData.active || runData.state === "running") {
    return `Instantánea del run: ${total} ${agentLabel}, ${running} en progreso. El HTML se refresca mientras el run siga activo, así que resultados y métricas pueden cambiar.`;
  }
  if (runData.state === "cancelled") {
    return `El run fue cancelado con ${total} ${agentLabel}. Usá este reporte para encontrar el último paso confiable antes de relanzar o resumir.`;
  }
  if (runData.state === "stale") {
    return `El run parece stale: hay ${total} ${agentLabel}, pero no se confirma un owner activo. Tratá este HTML como diagnóstico, no como veredicto final.`;
  }
  if (runData.state === "completed") {
    if (hasResults) return `${total} ${agentLabel} completaron el run sin fallas registradas. Empezá por Resultados; el diagrama y los prompts quedan abajo para auditar cómo se llegó ahí.`;
    return `${total} ${agentLabel} completaron el run sin fallas registradas y sin output final. Empezá por Agentes y luego usá el Diagrama como mapa de auditoría.`;
  }
  return `Estado del run: ${runData.state || "desconocido"}. Hay ${total} ${agentLabel}; el preview estático detectó ${nodeCount} tipos de nodo.`;
}

function topCallouts(runData) {
  if (!runData) return "";
  const callouts = [];
  if (runData.fail > 0) {
    const failed = runData.fail;
    callouts.push(`<div class="callout error"><b>Falla visible:</b> ${failed} ${plural(failed, "agente")} falló${failed === 1 ? "" : "n"}; no trates este reporte como aprobado hasta revisar esas tarjetas.</div>`);
  }
  if (runData.active || runData.state === "running") {
    callouts.push(`<div class="callout info"><b>Run activo:</b> este artefacto puede cambiar en el próximo refresh.</div>`);
  }
  if (runData.state === "stale") {
    callouts.push(`<div class="callout warn"><b>Stale:</b> no hay señal de owner activo; usalo para diagnosticar antes de continuar.</div>`);
  }
  return callouts.join("\n");
}

function tabButton(id, label, active, extraAttr = "") {
  const extra = extraAttr ? ` ${extraAttr}` : "";
  return `<button data-t="${id}"${extra}${active ? ' class="active"' : ""}>${label}</button>`;
}

const FALLBACK_TOKENS = `:root {
  --bg: #242526; --paper: #292A2B; --info-bg: #2E2A33; --raised: #31353A;
  --ink: #E6E6E6; --ink2: #BBBBBB; --muted: #757575; --line: #3E4250; --line-strong: #676B79;
  --accent: #FF75B5; --link: #6FC1FF; --info: #45A9F9; --success: #19F9D8; --warning: #FFCC95;
  --error: #FF4B82; --code: #19F9D8; --purple: #BCAAFE;
  --success-bg: #1E2E2B; --error-bg: #2E1E24; --warning-bg: #2E2A33;
}`;

function parseTokenVariants(tokensCss = FALLBACK_TOKENS) {
  let split = tokensCss.search(/@media[^{]*prefers-color-scheme:\s*light/);
  if (split < 0) split = tokensCss.length;
  const grab = (css) => {
    const vars = {};
    for (const m of css.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) vars[m[1]] = m[2];
    return vars;
  };
  const dark = grab(tokensCss.slice(0, split));
  const light = grab(tokensCss.slice(split));
  return { dark, light: Object.keys(light).length ? light : dark };
}

function mermaidThemeVariables(vars) {
  return {
    background: vars.bg,
    mainBkg: vars.paper,
    primaryColor: vars.raised,
    primaryTextColor: vars.ink,
    primaryBorderColor: vars["line-strong"],
    lineColor: vars.muted,
    secondaryColor: vars["info-bg"],
    tertiaryColor: vars.raised,
    textColor: vars.ink2,
    titleColor: vars.accent,
    nodeTextColor: vars.ink,
    edgeLabelBackground: vars.bg,
    clusterBkg: vars["info-bg"],
    clusterBorder: vars.line,
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif',
  };
}

function classDefs(vars) {
  const v = (name, fallback) => vars[name] || fallback;
  const bg = v("bg", "#242526");
  const paper = v("paper", "#292A2B");
  const raised = v("raised", "#31353A");
  const ink = v("ink", "#E6E6E6");
  const ink2 = v("ink2", "#BBBBBB");
  const muted = v("muted", "#757575");
  const line = v("line", "#3E4250");
  return [
    `  classDef io fill:${raised},stroke:${muted},color:${ink};`,
    `  classDef ag fill:${paper},stroke:${line},color:${ink};`,
    `  classDef agok fill:${v("success-bg", paper)},stroke:${v("success", line)},color:${ink};`,
    `  classDef agr fill:${v("info-bg", paper)},stroke:${v("info", line)},color:${ink};`,
    `  classDef agf fill:${v("error-bg", paper)},stroke:${v("error", line)},color:${ink};`,
    `  classDef comp fill:${v("info-bg", paper)},stroke:${v("purple", line)},color:${ink};`,
    `  classDef empty fill:${bg},stroke:${line},color:${ink2};`,
  ].join("\n");
}

const COMPONENT_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif;}
.container{max-width:980px;margin:0 auto;padding:0 24px 80px;}
header{padding:40px 0 8px;}
header .kicker{font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:600;}
header h1{margin:6px 0;font-size:34px;}
header p{margin:0;color:var(--ink2);max-width:74ch;}
.opening{margin:16px 0 8px;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:12px;padding:12px 16px;font-size:17px;line-height:1.55;max-width:74ch;}
.section-intro{margin:0 0 14px;color:var(--ink2);max-width:74ch;font-size:16px;}
.callout{margin:12px 0;padding:10px 14px;border-radius:10px;border:1px solid var(--line);color:var(--ink);font-size:15.5px;}.callout b{color:var(--ink);}.callout.info{background:var(--info-bg);border-color:var(--info);}.callout.warn{background:var(--warning-bg);border-color:var(--warning);}.callout.error{background:var(--error-bg);border-color:var(--error);}
a{color:var(--link);}
.prov{margin:0 0 16px;padding:12px 16px;background:var(--paper);border:1px solid var(--line);border-radius:12px;font-size:16px;color:var(--ink2);}
.prov b{color:var(--ink);}.prov a{color:var(--link);}.prov .cite{font-family:ui-monospace,Menlo,monospace;color:var(--muted);}
.prov code{font-family:ui-monospace,Menlo,monospace;font-size:14px;color:var(--code);background:var(--raised);padding:2px 7px;border-radius:6px;word-break:break-all;}
.trole{font-size:14px;color:var(--muted);margin-top:2px;}.subh{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:18px 0 10px;}
.chips{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;}.chip{font-size:14px;padding:4px 10px;border-radius:999px;background:var(--raised);border:1px solid var(--line);color:var(--ink2);}
.monitor-hero{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px;}.monitor-title{font-size:22px;font-weight:700;color:var(--ink);display:flex;gap:10px;align-items:center;flex-wrap:wrap;}.monitor-hero p{margin:6px 0 0;color:var(--ink2);max-width:74ch;}.monitor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-bottom:14px;}.metric-card{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:12px;min-height:90px;}.metric-label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);}.metric-value{font-size:24px;line-height:1.2;color:var(--ink);font-weight:700;margin-top:4px;}.metric-detail{font-size:13px;color:var(--ink2);margin-top:6px;}.meter{display:inline-block;width:76px;height:8px;border-radius:999px;background:var(--raised);border:1px solid var(--line);overflow:hidden;vertical-align:middle;margin-right:6px;}.meter span{display:block;height:100%;background:var(--success);}.meter.fail span{background:var(--error);}.meter.run span{background:var(--info);}.meter.warn span{background:var(--warning);}.monitor-table{width:100%;border-collapse:collapse;background:var(--paper);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:14px;font-size:14px;}.monitor-table th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);background:var(--raised);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);}.monitor-table td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink2);}.monitor-table tr:last-child td{border-bottom:0;}.monitor-table tr.featured td{background:var(--info-bg);}.muted-mini{font-size:12px;color:var(--muted);}.mono-mini{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);}
.runbanner{margin:14px 0 4px;padding:10px 14px;border-radius:10px;font-size:15.5px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;}.runbanner b{font-weight:700;color:var(--ink);}
.runbanner.ok{background:var(--success-bg);border:1px solid var(--success);color:var(--ink);}.runbanner.run{background:var(--info-bg);border:1px solid var(--info);color:var(--ink);}.runbanner.fail{background:var(--error-bg);border:1px solid var(--error);color:var(--ink);}
.banner{margin:18px 0 8px;padding:10px 14px;background:var(--error-bg);border:1px solid var(--error);border-radius:10px;color:var(--ink);font-size:16px;}
.warn{margin:10px 0;padding:8px 12px;background:var(--warning-bg);border:1px solid var(--warning);border-radius:8px;color:var(--ink);font-size:15px;}
nav.tabs{position:sticky;top:0;background:var(--bg);padding:14px 0;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);z-index:5;}
nav.tabs button{font:inherit;font-size:16px;border:1px solid var(--line);background:var(--paper);color:var(--ink2);padding:7px 14px;border-radius:8px;cursor:pointer;}
nav.tabs button:hover{background:var(--raised);color:var(--ink);}nav.tabs button.active{background:var(--accent);border-color:var(--accent);color:var(--bg);font-weight:600;}
section{display:none;padding-top:24px;}section.active{display:block;}
h2.sec{font-size:15.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 14px;}
.card{background:var(--paper);border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden;}
.card>.head{padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;}.card>.head:hover{background:var(--raised);}
.badge{font-size:13px;font-weight:600;padding:3px 9px;border-radius:6px;background:var(--raised);border:1px solid var(--line);color:var(--ink);white-space:nowrap;}
.rpill{font-size:13px;font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap;}.rpill.ok{background:var(--success-bg);color:var(--success);border:1px solid var(--success);}.rpill.fail{background:var(--error-bg);color:var(--error);border:1px solid var(--error);}.rpill.run{background:var(--info-bg);color:var(--info);border:1px solid var(--info);}.rpill.warn{background:var(--warning-bg);color:var(--warning);border:1px solid var(--warning);}
.nid{font-family:ui-monospace,Menlo,monospace;font-size:16px;font-weight:600;color:var(--info);}.me{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--ink2);background:var(--raised);border:1px solid var(--line);padding:2px 8px;border-radius:999px;white-space:nowrap;}.schema{margin-left:auto;font-size:14px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;}
.card .body{display:none;border-top:1px solid var(--line);}.card.open .body{display:block;}.caret{color:var(--muted);transition:transform .15s;}.card.open .caret{transform:rotate(90deg);}
.meta-row{display:flex;gap:18px;flex-wrap:wrap;padding:12px 16px;background:var(--raised);border-bottom:1px solid var(--line);font-size:15px;color:var(--ink2);}.meta-row b{color:var(--ink);}
.skrow{padding:10px 16px;background:var(--raised);border-bottom:1px solid var(--line);font-size:15px;color:var(--ink2);display:flex;gap:6px;align-items:center;flex-wrap:wrap;}.skrow b{color:var(--ink);margin-right:4px;}.skill{font-size:14px;padding:3px 9px;border-radius:6px;background:var(--success-bg);border:1px solid var(--success);color:var(--success);font-family:ui-monospace,Menlo,monospace;}
.skref{font-size:13px;color:var(--muted);}.skref code{background:var(--raised);color:var(--code);padding:1px 5px;border-radius:4px;font-size:12.5px;}.skmiss{color:var(--error);font-size:13px;}
.card.warn-skills{box-shadow:inset 4px 0 0 var(--warning);}.warnbadge{font-size:12.5px;font-weight:600;padding:3px 8px;border-radius:6px;background:var(--warning-bg);color:var(--warning);border:1px solid var(--warning);white-space:nowrap;}
.rout{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:14px;line-height:1.55;padding:12px 16px;color:var(--ink);background:var(--raised);border-bottom:1px solid var(--line);}.rout .lbl{display:block;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;}.rart{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--muted);padding:8px 16px;border-bottom:1px solid var(--line);word-break:break-all;}
.prompt{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:16px;line-height:1.6;padding:16px;color:var(--ink);}.copy{float:right;font:inherit;font-size:14px;border:1px solid var(--line);background:var(--paper);border-radius:7px;padding:4px 10px;cursor:pointer;color:var(--ink2);}.copy:hover{background:var(--raised);color:var(--ink);}
pre.block{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto;font-size:16px;color:var(--ink);} .diagram{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto;}
.hljs{background:transparent;color:var(--ink);}.hljs-keyword,.hljs-selector-tag,.hljs-subst{color:var(--accent);}.hljs-title,.hljs-section,.hljs-name,.hljs-function .hljs-title{color:var(--info);}.hljs-string,.hljs-doctag,.hljs-regexp{color:var(--success);}.hljs-number,.hljs-literal,.hljs-symbol,.hljs-bullet{color:var(--warning);}.hljs-type,.hljs-class .hljs-title,.hljs-built_in{color:var(--purple);}.hljs-comment,.hljs-quote{color:var(--line-strong);font-style:italic;}.hljs-attr,.hljs-attribute,.hljs-meta{color:var(--ink2);}.hljs-deletion{color:var(--error);}.hljs-addition{color:var(--success);}
.tname{font-family:ui-monospace,Menlo,monospace;font-weight:600;color:var(--info);}
.mdbody{padding:6px 18px 16px;color:var(--ink2);font-size:18px;line-height:1.7;}.mdbody h1{font-size:24px;margin:16px 0 8px;color:var(--ink);}.mdbody h2{font-size:19px;margin:14px 0 6px;color:var(--ink);}.mdbody h3{font-size:17px;margin:12px 0 6px;color:var(--ink);}.mdbody ol,.mdbody ul{padding-left:22px;margin:6px 0;}.mdbody li{margin:3px 0;}.mdbody p{margin:8px 0;}.mdbody code{font-family:ui-monospace,Menlo,monospace;font-size:16px;color:var(--code);background:var(--raised);padding:1px 5px;border-radius:5px;}.mdbody pre{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;}.mdbody pre code{background:none;padding:0;color:var(--ink);}.mdbody a{color:var(--link);}.mdbody blockquote{border-left:3px solid var(--accent);margin:8px 0;padding:2px 12px;color:var(--ink2);}.mdbody table{border-collapse:collapse;margin:8px 0;background:var(--paper);}.mdbody th,.mdbody td{border:1px solid var(--line);padding:5px 10px;}.mdbody th{color:var(--muted);background:var(--raised);}
footer{margin-top:40px;color:var(--muted);font-size:15px;}
`;

// Arma { html, data } desde el modelo estático + nodos mergeados + data opcional del run.
export function assembleArtifact({ merged, basePhases, composes, meta, provenance, scaffolds, scriptPath, argsJson, schemas, skillRefs, raw, runData, staticFidelity, jsonToMarkdownSource, clientJsSource, contractViewSource, tokensCss = FALLBACK_TOKENS }) {
  const nodes = merged.nodes;
  const phases = [...basePhases, ...merged.extraPhases.filter((p) => !basePhases.includes(p))];
  const tokenVariants = parseTokenVariants(tokensCss);
  const mermaidThemes = { dark: mermaidThemeVariables(tokenVariants.dark), light: mermaidThemeVariables(tokenVariants.light) };

  // Mermaid automático: IN -> grupos de fases en orden -> OUT, más aristas de compose
  const nodesByPhase = {};
  for (const n of nodes) (nodesByPhase[n.phase] ||= []).push(n);
  // El diagrama debe mostrar toda fase que tenga nodos — primero las fases declaradas y después cualquier
  // fase extra de nodo (por ejemplo "—" para agentes a los que el workflow nunca etiquetó con fase) para que no se pierdan nodos.
  const nodePhases = Object.keys(nodesByPhase);
  const orderedPhases = [...phases, ...nodePhases.filter((p) => !phases.includes(p))];
  const nodeInstances = (node) => Math.max(1, node.run?.planned ?? node.run?.count ?? node.instances ?? 1);
  const fanoutSlots = (count) => count <= 6 ? Array.from({ length: count }, (_value, index) => index + 1) : [1, 2, "…", count];
  let mm = "flowchart TB\n  IN([entrada args]):::io\n";
  orderedPhases.forEach((ph) => {
    const ns = nodesByPhase[ph] || [];
    mm += `  subgraph ${mmId(ph)}["${mmLabel(ph)}"]\n   direction LR\n`;
    ns.forEach((n, i) => {
      const id = `${mmId(ph)}_${i}`;
      const me = nodeME(n);
      const glyph = n.run ? (n.run.fail ? ` · ✗${n.run.fail}/${n.run.count}` : n.run.running ? ` · ⏳${n.run.running}` : ` · ✓${n.run.count}`) : "";
      const cls = n.run ? (n.run.fail ? "agf" : n.run.running ? "agr" : "agok") : "ag";
      const instances = nodeInstances(n);
      if (n.parallel && instances > 1) {
        const forkId = `${id}_fork`;
        const joinId = `${id}_join`;
        const laneGlyph = n.run ? (n.run.fail ? " · ✗" : n.run.running ? " · ⏳" : " · ✓") : "";
        mm += `   ${forkId}(("fork ×${instances}")):::comp\n`;
        for (const [laneIndex, slot] of fanoutSlots(instances).entries()) {
          const laneId = `${id}_lane${laneIndex + 1}`;
          const laneLabel = `${mmLabel(n.role)} ${slot}${n.schemaObj ? " · schema" : ""}${me ? " · " + mmLabel(me) : ""}${laneGlyph}`;
          mm += `   ${laneId}["${laneLabel}"]:::${cls}\n`;
          mm += `   ${forkId} --> ${laneId}\n`;
          mm += `   ${laneId} --> ${joinId}\n`;
        }
        mm += `   ${joinId}(("join")):::comp\n`;
        return;
      }
      mm += `   ${id}["${mmLabel(n.role)}${n.schemaObj ? " · schema" : ""}${me ? " · " + mmLabel(me) : ""}${glyph}"]:::${cls}\n`;
    });
    if (!ns.length) mm += `   ${mmId(ph)}_x["sin agentes · solo bash o no alcanzado"]:::empty\n`;
    mm += "  end\n";
  });
  let prev = "IN";
  orderedPhases.forEach((ph) => { mm += `  ${prev} --> ${mmId(ph)}\n`; prev = mmId(ph); });
  mm += `  ${prev} --> OUT[/"return"/]:::io\n`;
  composes.forEach((c, i) => { mm += `  COMP${i}{{"workflow ${mmLabel(c)}"}}:::comp\n  ${prev} -. compone .-> COMP${i}\n`; });
  mm += classDefs(tokenVariants.dark);

  // Fidelity notes — una caja vacía nunca debe leerse como "sin agentes" cuando en realidad está gated por runtime.
  const fidelityNotes = [...staticFidelity];
  const declaredPhaseTitles = (meta.phases || []).map(phaseTitleOf).filter(Boolean);
  const emptyDeclared = declaredPhaseTitles.filter((t) => !nodes.some((n) => n.phase === t));
  if (emptyDeclared.length) fidelityNotes.push("fase(s) declarada(s) sin agentes registrados: " + emptyDeclared.join(", ") + (runData ? " — todavía depende de valores runtime o solo bash (no alcanzada en este run)" : " — probablemente depende de valores runtime; ver la pestaña Script completo"));

  const run = runData ? { runId: runData.runId, state: runData.state, active: runData.active, agentCount: runData.agentCount, ok: runData.ok, fail: runData.fail, running: runData.running, elapsedMs: runData.elapsedMs } : null;
  const contract = detectContract(runData);
  const hasContract = !!contract;
  const warnText = fidelityNotes.length ? fidelityNotes.join(" · ") : null;
  const argsLabel = argsJson ? "(provistos)" : "(defaults de extracción)";
  const data = {
    meta, phases, composes, __mm: mm, mermaidThemes,
    provenance, scaffolds, source: scriptPath,
    args: argsLabel,
    schemas, nodes, skillRefs, script: raw, run, ...(hasContract ? { contract } : {}),
    results: runData ? runData.results : null,
    warn: warnText,
  };
  const jsonBlob = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const autoRefresh = !!(runData && runData.active);
  const hasRun = !!runData;
  const hasResults = !!(runData && runData.results);
  const initialTab = "monitor";
  const opening = escHtml(openingText({ runData, nodeCount: nodes.length, argsJson, hasResults }));
  const callouts = topCallouts(runData);
  const tabMap = {
    monitor: tabButton("monitor", "Monitor", initialTab === "monitor"),
    results: tabButton("results", "Resultados", initialTab === "results", 'id="tabresults"'),
    plan: tabButton("plan", "Plan", initialTab === "plan"),
    overview: tabButton("overview", "Diagrama", initialTab === "overview"),
    contract: hasContract ? tabButton("contract", "Contrato", false) : "",
    agents: tabButton("agents", "Agentes y prompts", initialTab === "agents"),
    schemas: tabButton("schemas", "Schemas", false),
    based: tabButton("based", "Basado en", false),
    script: tabButton("script", "Script completo", false),
  };
  const tabs = (hasRun
    ? hasResults
      ? [tabMap.monitor, tabMap.results, tabMap.plan, tabMap.agents, tabMap.overview, tabMap.contract, tabMap.schemas, tabMap.based, tabMap.script]
      : [tabMap.monitor, tabMap.plan, tabMap.agents, tabMap.overview, tabMap.contract, tabMap.results, tabMap.schemas, tabMap.based, tabMap.script]
    : [tabMap.monitor, tabMap.plan, tabMap.overview, tabMap.agents, tabMap.schemas, tabMap.based, tabMap.script, tabMap.results]
  ).filter(Boolean).join("");
  const active = (id) => (initialTab === id ? ' class="active"' : "");
  const monitorHtml = renderWorkflowMonitor({ meta, phases, nodes, runData, args: argsLabel, warn: warnText, source: scriptPath });
  const monitorSection = `<section data-s="monitor"${active("monitor")}><h2 class="sec">Monitor — estado, progreso y evidencia</h2><p class="section-intro">Esta vista replica la lectura del monitor de workflow: primero estado y progreso; después agentes, actividad y rutas crudas para depurar.</p>${monitorHtml}</section>`;
  const planHtml = renderWorkflowPlan({ meta, phases, nodes, composes, scaffolds, provenance, args: argsLabel, schemas, warn: warnText, source: scriptPath });
  const planSection = `<section data-s="plan"${active("plan")}><h2 class="sec">Plan — blueprint antes de ejecutar</h2><p class="section-intro">Este plan sale del workflow mismo: fases, agentes, contratos y composición detectados por el preview estático.</p>${planHtml}</section>`;
  const overviewSection = `<section data-s="overview"${active("overview")}><h2 class="sec">Orquestación</h2><p class="section-intro">El diagrama muestra la estructura detectada: fases, tipos de agente y composición entre workflows. Usalo como mapa; los prompts exactos están en la pestaña de agentes.</p><div class="diagram"><pre class="mermaid" id="mm"></pre></div></section>`;
  const contractSection = hasContract ? '<section data-s="contract"><h2 class="sec">Contrato — contrato de tarea del gate</h2><div class="mdbody" id="contract"></div></section>' : "";
  const resultsSection = `<section data-s="results"${active("results")}><h2 class="sec">Resultados — valor de retorno y artefactos</h2><div id="results"></div></section>`;
  const agentsSection = '<section data-s="agents"><h2 class="sec">Agentes — abrí para ver el prompt exacto</h2><div id="agents"></div></section>';
  const schemasSection = '<section data-s="schemas"><h2 class="sec">Schemas de structured output</h2><div id="schemas"></div></section>';
  const basedSection = '<section data-s="based"><h2 class="sec">Basado en — fuentes y scaffolds</h2><div id="based"></div></section>';
  const scriptSection = '<section data-s="script"><h2 class="sec">Script completo</h2><pre class="block"><code class="language-javascript" id="script"></code></pre></section>';
  const sections = hasRun
    ? hasResults
      ? [monitorSection, resultsSection, planSection, agentsSection, overviewSection, contractSection, schemasSection, basedSection, scriptSection]
      : [monitorSection, planSection, agentsSection, overviewSection, contractSection, resultsSection, schemasSection, basedSection, scriptSection]
    : [monitorSection, planSection, overviewSection, agentsSection, resultsSection, schemasSection, basedSection, scriptSection];

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${autoRefresh ? '<meta http-equiv="refresh" content="2">' : ""}
<title>${(meta.name || "workflow").replace(/[<>&]/g, "")} — workflow</title>
<style>
${tokensCss}
${COMPONENT_CSS}</style></head><body><div class="container">
  <header><div class="kicker">${artifactKicker(runData)}</div><h1 id="wf-name"></h1><p id="wf-desc"></p>
  <p class="opening">${opening}</p>
  ${callouts}
  <div class="runbanner" id="runbanner" style="display:none"></div>
  <div class="chips" id="wf-chips"></div>
  <div class="warn" id="warn" style="display:none"></div></header>
  <nav class="tabs" id="tabs">${tabs}</nav>
  ${sections.filter(Boolean).join("\n  ")}
  <footer>Generado con pandi-artifact-style · paleta: panda-syntax dark/light</footer>
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
