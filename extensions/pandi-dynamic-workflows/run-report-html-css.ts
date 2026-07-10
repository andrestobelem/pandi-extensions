/**
 * CSS inline del reporte HTML de run (tokens Pandi + layout).
 * Extraído de run-report-html.ts para mantener el builder enfocado en model→HTML.
 * PANDI_TOKENS_CSS se re-exporta desde run-report-html.ts (tests de paridad lo importan ahí).
 */

/* Tokens de artifact Pandi — inlineados por la regla de extensión autocontenida (la duplicación
 * por extensión es intencional). Pineados contra el canónico
 * .pi/skills/pandi-artifact-style/reference/pandi-tokens.css por el test de paridad run-report-tokens. */
export const PANDI_TOKENS_CSS = `:root {
  --bg: #242526;
  --paper: #292A2B;
  --info-bg: #2E2A33;
  --raised: #31353A;
  --ink: #E6E6E6;
  --ink2: #BBBBBB;
  --muted: #757575;
  --line: #3E4250;
  --line-strong: #676B79;
  --accent: #FF75B5;
  --accent-soft: #FF9AC1;
  --link: #6FC1FF;
  --info: #45A9F9;
  --success: #19F9D8;
  --warning: #FFCC95;
  --error: #FF4B82;
  --code: #19F9D8;
  --purple: #BCAAFE;
  --success-bg: #1E2E2B;
  --error-bg: #2E1E24;
  --warning-bg: #2E2A33;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ECECEC;
    --paper: #F2F1F1;
    --info-bg: #EDE4F8;
    --raised: #E6DBCB;
    --ink: #222223;
    --ink2: #676B79;
    --muted: #8D8D8D;
    --line: #C9C9C9;
    --line-strong: #676B79;
    --accent: #FF0077;
    --accent-soft: #FF629E;
    --link: #0091FF;
    --info: #0091FF;
    --success: #12B69D;
    --warning: #FF8400;
    --error: #FF4B82;
    --code: #12B69D;
    --purple: #B084EB;
    --success-bg: #DCEEEA;
    --error-bg: #F7DCE4;
    --warning-bg: #EDE4F8;
  }
}`;

export const LAYOUT_CSS = `
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.container { max-width: 1000px; margin: 0 auto; padding: 28px 20px 60px; }
header .kicker { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); font-weight:600; }
header h1 { margin:6px 0 2px; font-size:24px; color:var(--ink); }
header .sub { color:var(--ink2); font-size:13px; }
.chips { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 4px; }
.chip { font-size:12px; color:var(--ink2); background:var(--paper); border:1px solid var(--line); border-radius:999px; padding:3px 10px; }
.monitor-panel { background:var(--paper); border:1px solid var(--line); border-radius:14px; padding:14px; margin:18px 0; }
.monitor-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
.monitor-head h2 { margin:0; }
.monitor-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(135px,1fr)); gap:10px; margin:10px 0 14px; }
.metric-card { background:var(--bg); border:1px solid var(--line); border-radius:12px; padding:10px; min-height:82px; }
.metric-label { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.metric-value { font-size:22px; line-height:1.2; color:var(--ink); font-weight:700; margin-top:3px; }
.metric-detail { color:var(--ink2); font-size:12px; margin-top:5px; }
.meter { display:inline-block; width:70px; height:8px; border-radius:999px; background:var(--raised); border:1px solid var(--line); overflow:hidden; vertical-align:middle; margin-right:6px; }
.meter span { display:block; height:100%; background:var(--success); }
.meter.fail span { background:var(--error); }
.meter.run span { background:var(--info); }
.meter.warn span { background:var(--warning); }
.monitor-table { margin-top:8px; }
.monitor-table tr.featured td { background:var(--info-bg); }
.monitor-agent-head { display:flex; flex-wrap:wrap; gap:6px; align-items:center; color:var(--ink2); margin:4px 0 8px; }
.monitor-agent-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.monitor-agent-state { font-weight:700; }
.monitor-agent-state.ok { color:var(--success); }
.monitor-agent-state.run { color:var(--info); }
.monitor-agent-state.fail { color:var(--error); }
.monitor-agent-state.warn { color:var(--warning); }
.agent-chipline { display:flex; flex-wrap:wrap; gap:5px; }
.mini-chip { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:2px 7px; background:var(--bg); color:var(--ink2); font-size:11.5px; white-space:nowrap; }
.mini-chip.ok { border-color:var(--success); color:var(--success); background:var(--success-bg); }
.mini-chip.warn { border-color:var(--warning); color:var(--warning); background:var(--warning-bg); }
.mini-chip.fail { border-color:var(--error); color:var(--error); background:var(--error-bg); }
.monitor-selected { display:grid; gap:5px; }
.monitor-detail-line { color:var(--ink2); }
.monitor-subtitle { margin-top:4px; color:var(--muted); font-size:11px; letter-spacing:.08em; text-transform:uppercase; }
.rpill { font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px; white-space:nowrap; }
.rpill.ok   { background:var(--success-bg); color:var(--success); border:1px solid var(--success); }
.rpill.run  { background:var(--info-bg);    color:var(--info);    border:1px solid var(--info); }
.rpill.fail { background:var(--error-bg);   color:var(--error);   border:1px solid var(--error); }
.rpill.warn { background:var(--warning-bg); color:var(--warning); border:1px solid var(--warning); }
h2 { font-size:16px; color:var(--info); margin:28px 0 10px; }
.callout { margin:10px 0; padding:10px 14px; border-radius:10px; font-size:13.5px; border:1px solid var(--line); border-left-width:4px; background:var(--paper); color:var(--ink); }
.callout.info    { background:var(--info-bg);    border-color:var(--purple); }
.callout.warn    { background:var(--warning-bg); border-color:var(--warning); }
.callout.error   { background:var(--error-bg);   border-color:var(--error); }
.opening { margin:14px 0 8px; color:var(--ink); background:var(--paper); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:10px; padding:10px 14px; font-size:13.5px; }
table { border-collapse:collapse; width:100%; font-size:13px; }
th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--ink2); font-weight:600; }
details { background:var(--paper); border:1px solid var(--line); border-radius:12px; margin:10px 0; }
details > summary { padding:12px 16px; cursor:pointer; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
details > summary:hover { background:var(--raised); }
details .body { border-top:1px solid var(--line); padding:14px 16px; color:var(--ink2); }
details.fail-card { border-color:var(--error); }
pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px 12px; overflow-x:auto;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--ink); white-space:pre-wrap; word-break:break-word; }
pre.json-output { white-space:pre; }
.structured-output { color:var(--ink2); }
.structured-output details.raw-json { margin-top:12px; }
.timeline-list { list-style:none; margin:0; padding:4px 0 4px 20px; border-left:2px solid var(--line); }
.timeline-item { position:relative; margin:0 0 14px; padding-left:16px; }
.timeline-item::before { content:""; position:absolute; left:-26px; top:.45em; width:9px; height:9px; border-radius:999px; background:var(--paper); border:2px solid var(--accent); }
.timeline-time { display:block; color:var(--muted); font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; margin-bottom:2px; }
.timeline-message { color:var(--ink); }
.timeline-details { margin-top:6px; }
.md-body { color:var(--ink2); }
.md-body p, .md-body ul, .md-body ol, .md-body blockquote, .md-body table { margin:0 0 10px; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 { color:var(--ink); margin:14px 0 8px; }
.md-body h1 { font-size:18px; } .md-body h2 { font-size:16px; } .md-body h3, .md-body h4, .md-body h5, .md-body h6 { font-size:14px; }
.md-body code { color:var(--code); background:var(--raised); border-radius:5px; padding:1px 5px; }
.md-body pre code { background:none; padding:0; color:var(--ink); }
.md-body blockquote { border-left:3px solid var(--accent); padding-left:12px; color:var(--ink2); }
.md-body .md-image-alt, .md-body .md-link-text { color:var(--muted); font-style:italic; }
a { color:var(--link); }
.muted { color:var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
.kv { color:var(--ink2); font-size:12.5px; }
/* mermaid.run({securityLevel:"sandbox"}) reemplaza el contenido de .mermaid por un <iframe>:
   el elemento en sí vive en la página padre y hereda este CSS (su documento interno no). */
.mermaid { margin: 8px 0 16px; }
.mermaid iframe { border:0; background:transparent; width:100%; display:block; }
`;
