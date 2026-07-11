// monitor.mjs — renderer puro de la pestaña Monitor del workflow artifact.
// Replica la lectura del monitor TUI: estado, progreso, agentes, actividad y evidencia cruda.
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

const empty = (value) => value === undefined || value === null || value === "" || value === "—";
const shortModel = (value) => (value && value !== "inherited" ? String(value).split("/").pop() : "inherited");
const plural = (count, singular, pluralForm = `${singular}s`) => (count === 1 ? singular : pluralForm);

function meter(fraction, kind = "ok") {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return `<span class="meter ${kind}" title="${Math.round(pct * 100)}%"><span style="width:${Math.round(pct * 100)}%"></span></span>`;
}

function pill(kind, label) {
  return `<span class="rpill ${kind}">${esc(label)}</span>`;
}

function nodeState(node) {
  const run = node.run;
  if (!run) return { kind: "run", label: "planificado", done: false, failed: false, running: false };
  const total = Math.max(run.planned || 0, run.count || 0, (run.ok || 0) + (run.fail || 0) + (run.unknown || 0) + (run.running || 0));
  if (run.running) {
    const bits = [`corriendo ${run.running}/${total}`];
    if (run.fail) bits.push(`falló ${run.fail}`);
    if (run.ok) bits.push(`ok ${run.ok}`);
    if (run.unknown) bits.push(`unknown ${run.unknown}`);
    return { kind: "run", label: bits.join(" · "), done: false, failed: !!run.fail, running: true };
  }
  if (run.fail) return { kind: "fail", label: `falló ${run.fail}/${total}`, done: true, failed: true, running: false };
  if (run.unknown) return { kind: "warn", label: `unknown ${run.unknown}/${total}`, done: true, failed: false, running: false };
  if (run.ok) return { kind: "ok", label: `ok ${run.ok}/${total}`, done: true, failed: false, running: false };
  return { kind: "warn", label: "sin datos", done: false, failed: false, running: false };
}

function progress({ nodes, runData }) {
  if (runData?.progress) return runData.progress;
  if (runData) {
    const done = (runData.ok || 0) + (runData.fail || 0) + (runData.unknown || 0);
    const total = Math.max(runData.agentCount || 0, done + (runData.running || 0), nodes.length);
    return { done, total, running: runData.running || 0, failed: runData.fail || 0, fraction: total > 0 ? done / total : 0, kind: runData.runKind || "ok", value: `${done}/${total}` };
  }
  return { done: 0, total: nodes.length, running: 0, failed: 0, fraction: 0, kind: "run", value: `0/${nodes.length}` };
}

function pickFeaturedNode(nodes) {
  return nodes.find((node) => nodeState(node).failed) ?? nodes.find((node) => nodeState(node).running) ?? nodes[0];
}

function metric(label, value, detail = "") {
  return `<div class="metric-card"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value)}</div>${detail ? `<div class="metric-detail">${detail}</div>` : ""}</div>`;
}

function agentRow(node, featured) {
  const state = nodeState(node);
  const isFeatured = featured && node.id === featured.id && node.role === featured.role && node.phase === featured.phase;
  const skills = Array.isArray(node.skills) && node.skills.length ? node.skills.length : node.skills === false ? "off" : "default";
  const schema = empty(node.schema) ? "—" : node.schema;
  const output = node.run?.output ? ` · output: ${String(node.run.output).slice(0, 120)}` : "";
  return `<tr${isFeatured ? ' class="featured"' : ""}><td>${pill(state.kind, state.label)}</td><td><b>#${esc(node.id || node.role)}</b><div class="muted-mini">${esc(node.phase || "—")}</div></td><td>${esc(node.role || node.id || "agent")}${output ? `<div class="muted-mini">${esc(output.slice(3))}</div>` : ""}</td><td>${esc(shortModel(node.model))}</td><td>${esc(node.effort || "inherited")}</td><td>${esc(schema)}</td><td>${esc(node.tools || "inherited")}</td><td>${esc(skills)}</td></tr>`;
}

function featuredAgent(node) {
  if (!node) return '<div class="prov" style="color:var(--muted)">Sin agentes detectados todavía.</div>';
  const state = nodeState(node);
  const prompt = String(node.prompt || "").trim();
  const runOutput = node.run?.output ? `<div class="rout"><span class="lbl">output runtime · ${esc(node.id)}</span>${esc(node.run.output)}</div>` : "";
  const artifact = node.run?.artifact ? `<div class="rart">artifact: ${esc(node.run.artifact)}</div>` : "";
  return `<div class="card open"><div class="head"><span class="caret">▸</span>${pill(state.kind, state.label)}<span class="nid">${esc(node.id || node.role)}</span><span class="me">${esc(shortModel(node.model))} · ${esc(node.effort || "inherited")}</span><span class="schema">${esc(node.phase || "—")}</span></div><div class="body"><div class="meta-row"><span><b>schema</b> ${esc(node.schema || "—")}</span><span><b>tools</b> ${esc(node.tools || "inherited")}</span><span><b>skills</b> ${esc(Array.isArray(node.skills) && node.skills.length ? node.skills.join(", ") : "default")}</span><span><b>extensiones</b> ${esc(node.extensions || "inherited")}</span></div>${runOutput}${artifact}${prompt ? `<div class="prompt">${esc(prompt.slice(0, 1200))}${prompt.length > 1200 ? "\n…[truncated]" : ""}</div>` : ""}</div></div>`;
}

function activityBlock(runData) {
  const logs = runData?.logs || [];
  if (!logs.length) return '<div class="prov" style="color:var(--muted)">Sin logs registrados todavía.</div>';
  const latest = logs.slice(-6).reverse();
  return `<table class="monitor-table"><thead><tr><th>hora</th><th>mensaje</th></tr></thead><tbody>${latest.map((log) => `<tr><td class="mono-mini">${esc(String(log.time || "").slice(11, 19) || "—")}</td><td>${esc(log.message || "")}</td></tr>`).join("")}</tbody></table>`;
}

export function renderWorkflowMonitor({ meta = {}, phases = [], nodes = [], runData = null, args = "", warn = null, source = "", previewMode = "parse-only" } = {}) {
  const p = progress({ nodes, runData });
  const total = Math.max(0, p.total || 0);
  const frac = p.fraction !== undefined ? p.fraction : total > 0 ? p.done / total : 0;
  const featured = pickFeaturedNode(nodes);
  const previewLabel = previewMode === "evaluated" ? "preview evaluado" : "preview estático";
  const stateLabel = runData ? runData.state || "unknown" : previewLabel;
  const stateKind = runData ? runData.runKind || (runData.state === "failed" ? "fail" : runData.active || runData.state === "running" ? "run" : runData.state === "completed" ? "ok" : "warn") : "run";
  const artifactCount = runData?.results?.artifacts?.length || 0;
  const lastLog = runData?.logs?.slice(-1)[0];
  const title = meta.name || "workflow";
  const desc = meta.description || "Sin descripción declarada.";
  const phaseChips = phases.length ? phases.map((phase) => `<span class="chip">${esc(phase)}</span>`).join("") : '<span class="chip">sin fases declaradas</span>';
  const warnBlock = warn ? `<div class="callout warn"><b>Riesgo de preview:</b> ${esc(warn)}</div>` : "";

  return [
    '<div class="subh">Estado del workflow</div>',
    `<div class="monitor-hero"><div><div class="monitor-title">${esc(title)} ${pill(stateKind, stateLabel)}</div><p>${esc(desc)}</p><div class="chips">${phaseChips}<span class="chip">args: ${esc(args)}</span>${source ? `<span class="chip">source: ${esc(source.split("/").pop())}</span>` : ""}</div></div></div>`,
    warnBlock,
    '<div class="subh">Progreso</div>',
    `<div class="monitor-grid">${metric("agents", p.value || `${p.done}/${total}`, `${meter(frac, p.kind || "ok")} <span>${Math.round(frac * 100)}%</span>`)}${metric("parallel", runData ? String(p.running) : "preview", runData ? "corriendo ahora" : "se confirma al correr")}${metric("failed", String(p.failed), p.failed ? "revisar tarjetas fallidas" : "sin fallas registradas")}${metric("bash", String(runData?.bashDone ?? 0), "comandos completados")}${metric("artifacts", String(artifactCount), "root artifacts detectados")}${metric("last", lastLog ? `${String(lastLog.time || "").slice(11, 19)} ${lastLog.message}` : "—", "última actividad")}</div>`,
    '<div class="subh">Agentes</div>',
    nodes.length
      ? `<table class="monitor-table"><thead><tr><th>estado</th><th>id/fase</th><th>rol</th><th>modelo</th><th>esfuerzo</th><th>schema</th><th>tools</th><th>skills</th></tr></thead><tbody>${nodes.map((node) => agentRow(node, featured)).join("")}</tbody></table>`
      : `<div class="prov" style="color:var(--muted)">Sin agentes detectados en el ${previewLabel}.</div>`,
    '<div class="subh">Agente destacado</div>',
    featuredAgent(featured),
    '<div class="subh">Actividad</div>',
    activityBlock(runData),
  ].join("\n");
}
