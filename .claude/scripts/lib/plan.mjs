// plan.mjs — renderer puro de la pestaña Plan del workflow artifact.
// Convierte el modelo estático ya extraído (meta/fases/nodos/composición/procedencia)
// en una lectura humana de “qué se va a ejecutar” antes de lanzar el run.
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");

const empty = (value) => value === undefined || value === null || value === "" || value === "—";
const unique = (items) => [...new Set(items.filter((x) => !empty(x)).map(String))];
const mono = (value) => `<code>${esc(value)}</code>`;

function phaseOrder(phases, nodes) {
  const fromNodes = unique(nodes.map((n) => n.phase || "—"));
  return [...unique(phases), ...fromNodes.filter((p) => !phases.includes(p))];
}

function phaseCards(phases, nodes) {
  const ordered = phaseOrder(phases, nodes);
  if (!ordered.length) return '<div class="prov" style="color:var(--muted)">Sin fases detectadas en el preview estático.</div>';
  return ordered.map((phase) => {
    const ns = nodes.filter((n) => (n.phase || "—") === phase);
    const body = ns.length
      ? `<ul>${ns.map((n) => `<li><b>${esc(n.id || n.role)}</b>${empty(n.schema) ? "" : ` · schema: ${esc(n.schema)}`}${empty(n.model) ? "" : ` · modelo: ${esc(n.model)}`}${empty(n.effort) ? "" : ` · esfuerzo: ${esc(n.effort)}`}</li>`).join("")}</ul>`
      : '<p style="color:var(--muted)">Sin agentes detectados; puede ser fase solo-bash, runtime-gated o no alcanzada por el preview.</p>';
    return `<div class="card open"><div class="head"><span class="nid">${esc(phase)}</span><span class="schema">${ns.length} nodo${ns.length === 1 ? "" : "s"}</span></div><div class="body"><div class="mdbody">${body}</div></div></div>`;
  }).join("");
}

function agentCards(nodes) {
  if (!nodes.length) return '<div class="prov" style="color:var(--muted)">Sin agentes detectados en el preview estático.</div>';
  return nodes.map((n) => {
    const skills = Array.isArray(n.skills) && n.skills.length ? n.skills.map((s) => `<span class="skill">${esc(s)}</span>`).join(" ") : '<span style="color:var(--muted)">inherited/ninguno declarado</span>';
    const prompt = String(n.prompt || "").trim();
    return `<div class="card"><div class="head"><span class="badge">${esc(n.phase || "—")}</span><span class="nid">${esc(n.id || n.role)}</span><span class="me" title="model · effort">${esc(n.model || "inherited")} · ${esc(n.effort || "inherited")}</span><span class="schema">schema: ${esc(n.schema || "—")}</span></div><div class="body"><div class="meta-row"><span><b>tools</b> ${esc(n.tools || "inherited")}</span><span><b>extensiones</b> ${esc(n.extensions || "inherited")}</span></div><div class="skrow"><b>skills</b>${skills}</div>${prompt ? `<div class="prompt">${esc(prompt)}</div>` : ""}</div></div>`;
  }).join("");
}

function compositionBlock(composes) {
  if (!composes.length) return '<div class="prov" style="color:var(--muted)">Sin sub-workflows detectados vía <code>workflow()</code>.</div>';
  return `<div class="prov"><b>Sub-workflows:</b> ${composes.map(mono).join(" · ")}</div>`;
}

function provenanceBlock({ provenance, scaffolds, source }) {
  const bits = [];
  if (provenance) bits.push(`<div><b>Basado en:</b> ${esc(provenance)}</div>`);
  if (scaffolds.length) {
    bits.push(`<div><b>Scaffolds:</b> ${scaffolds.map((s) => esc(s.name || s)).join(" · ")}</div>`);
  }
  if (source) bits.push(`<div><b>Fuente:</b> ${mono(source)}</div>`);
  return bits.length ? `<div class="prov">${bits.join("")}</div>` : '<div class="prov" style="color:var(--muted)">Sin procedencia declarada.</div>';
}

function evidenceBlock({ schemas, warn }) {
  const schemaNames = Object.keys(schemas || {});
  const schemaLine = schemaNames.length
    ? `Schemas declarados: ${schemaNames.map(mono).join(" · ")}.`
    : "Sin schemas de structured output declarados; el contrato final se confirma al correr.";
  const warnLine = warn ? `<div class="callout warn"><b>Riesgo de preview:</b> ${esc(warn)}</div>` : "";
  return `<div class="prov"><b>Evidencia esperada:</b> ${schemaLine} Los artifacts y el valor de retorno se completan en la pestaña Resultados después del run.</div>${warnLine}`;
}

export function renderWorkflowPlan({ meta = {}, phases = [], nodes = [], composes = [], scaffolds = [], provenance = null, args = "", schemas = {}, warn = null, source = "" } = {}) {
  const name = meta.name || "workflow";
  const desc = meta.description || "Sin descripción declarada.";
  return [
    `<div class="prov"><b>Qué va a ejecutar:</b> <span class="tname">${esc(name)}</span><br>${esc(desc)}<br><b>Args:</b> ${esc(args)}</div>`,
    '<div class="subh">Fases</div>',
    phaseCards(phases, nodes),
    '<div class="subh">Agentes y contratos</div>',
    agentCards(nodes),
    '<div class="subh">Composición</div>',
    compositionBlock(composes),
    '<div class="subh">Procedencia</div>',
    provenanceBlock({ provenance, scaffolds, source }),
    '<div class="subh">Evidencia y riesgos</div>',
    evidenceBlock({ schemas, warn }),
  ].join("\n");
}
