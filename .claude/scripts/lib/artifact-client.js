// artifact-client.js — client-side app logic for the workflow artifact HTML.
// Extracted from the builder so it lives in a real .js file (normal escaping, node -c'able)
// instead of inside a template literal. The builder inlines jsonToMarkdown() above this, then
// interpolates this file via ${...} (its content is never re-parsed, so no escaping traps).
const D=JSON.parse(document.getElementById("data").textContent);
const esc=(s)=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const PAL=["#3f7a52","#7a4fb0","#b54545","#9a6a14","#2f6f9e","#a3517a"];
const pc={}; (D.phases||[]).forEach((p,i)=>pc[p]=PAL[i%PAL.length]);
// Render the diagram FIRST and in isolation: set #mm content, then run mermaid explicitly.
// (startOnLoad races other DOM code — if anything below throws, #mm stays empty and mermaid renders "Syntax error".)
(function(){try{
  var mmEl=document.getElementById("mm");
  mmEl.textContent=D.__mm||"";
  mermaid.initialize({startOnLoad:false,theme:"neutral",flowchart:{useMaxWidth:false}});
  mermaid.run({nodes:[mmEl]}).catch(function(){});
}catch(e){}})();
document.getElementById("wf-name").textContent=D.meta.name||"workflow";
document.getElementById("wf-desc").textContent=D.meta.description||"";
if(D.run){var rb=document.getElementById("runbanner");var cls=D.run.fail?"fail":(D.run.active?"run":"ok");rb.className="runbanner "+cls;rb.style.display="flex";rb.innerHTML='<b>Run '+esc(D.run.state)+'</b>'+(D.run.active?' · live · auto-refresh 2s':'')+' · '+D.run.agentCount+' agents · '+D.run.ok+' ok'+(D.run.fail?' · '+D.run.fail+' failed':'')+(D.run.running?' · '+D.run.running+' running':'')+(D.run.elapsedMs?' · '+(D.run.elapsedMs/1000).toFixed(1)+'s':'')+' · <span style="color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:11px">'+esc(D.run.runId)+'</span>';}
document.getElementById("wf-chips").innerHTML=(D.phases||[]).map(p=>'<span class="chip">'+esc(p)+'</span>').join("")+'<span class="chip">'+D.nodes.length+' node types</span><span class="chip">args: '+esc(D.args)+'</span>';
if(D.warn){const w=document.getElementById("warn");w.style.display="block";w.textContent="⚠ "+D.warn;}
const meLabel=(n)=>{const m=(n.model&&n.model!=="inherited")?String(n.model).split("/").pop():"inherited";const e=n.effort||"inherited";return m+" · "+e;};
const rpill=(n)=>{if(!n.run)return "";const r=n.run;const cls=r.fail?"fail":r.running?"run":"ok";const txt=r.fail?("✗ "+r.fail+"/"+r.count):r.running?("⏳ "+r.running+"/"+r.count):("✓ "+r.count);return '<span class="rpill '+cls+'" title="runtime result">'+txt+'</span>';};
// Code-worker guardrail: a code-phase agent should load the two WORKER skills (karpathy + modern);
// ai-assisted-engineering is the orchestrator's lens (AGENTS.md), so it is NOT required per worker.
const CODE_RE=/build|implement|code|refactor|fix|dev|migrat|patch|feature/i;
const WORKER_SKILLS=["karpathy-guidelines","modern-software-engineering"];
const isCodePhase=(n)=>CODE_RE.test((n.phase||"")+" "+(n.role||"")+" "+(n.id||""));
const missingWorkerSkills=(n)=>{const have=n.skills||[];return WORKER_SKILLS.filter(s=>have.indexOf(s)<0);};
const codeGap=(n)=>isCodePhase(n)&&missingWorkerSkills(n).length>0;
// Each skill chip, followed by its on-disk reference docs (from D.skillRefs) or a not-found marker.
const skillChips=(n)=>(n.skills||[]).map(function(s){
  var info=(D.skillRefs&&D.skillRefs[s])||{};
  var refs=info.references||[];
  var miss=info.missing?' <span class="skmiss" title="skill no encontrado en disco">(no hallado)</span>':'';
  var refhtml=refs.length?'<span class="skref"> · refs: '+refs.map(function(r){return '<code>'+esc(r)+'</code>';}).join(" ")+'</span>':'';
  return '<span class="skill">'+esc(s)+'</span>'+miss+refhtml;
}).join(" ");
document.getElementById("agents").innerHTML=D.nodes.map((n,i)=>'<div class="card'+(codeGap(n)?' warn-skills':'')+'"><div class="head"><span class="caret">▸</span><span class="badge" style="background:'+(pc[n.phase]||"#8a877f")+'">'+esc(n.phase)+'</span><span class="nid">'+esc(n.id)+'</span><span class="me" title="model · effort">'+esc(meLabel(n))+'</span>'+(n.skills&&n.skills.length?'<span class="me" title="skills loaded">🧠 '+n.skills.length+'</span>':'')+(codeGap(n)?'<span class="warnbadge" title="fase de código sin '+missingWorkerSkills(n).join(" + ")+'">⚠ faltan skills de código</span>':'')+rpill(n)+'<span class="schema">schema: '+esc(n.schema)+'</span></div><div class="body"><div class="meta-row"><span><b>phase</b> '+esc(n.phase)+'</span><span><b>model</b> '+esc(n.model)+'</span><span><b>effort</b> '+esc(n.effort)+'</span><span><b>tools</b> '+esc(n.tools)+'</span><span><b>extensions</b> '+esc(n.extensions)+'</span>'+(n.runtimeOnly?'<span><b>source</b> runtime-only (declared phase/model inferred)</span>':'')+'</div>'+(n.skills&&n.skills.length?'<div class="skrow"><b>skills</b>'+skillChips(n)+'</div>':'')+(n.run&&n.run.output?'<div class="rout"><span class="lbl">runtime output · '+esc(n.id)+(n.run.count>1?' (first of '+n.run.count+')':'')+'</span>'+esc(n.run.output)+'</div>':'')+(n.run&&n.run.artifact?'<div class="rart">artifact: '+esc(n.run.artifact)+'</div>':'')+'<div class="prompt"><button class="copy" data-c="'+i+'">copy</button>'+esc(n.prompt.trim())+'</div></div></div>').join("");
document.querySelectorAll(".card .head").forEach(h=>h.onclick=()=>h.parentElement.classList.toggle("open"));
document.querySelectorAll(".copy").forEach(b=>b.onclick=(e)=>{e.stopPropagation();navigator.clipboard.writeText(D.nodes[b.dataset.c].prompt);b.textContent="copied!";setTimeout(()=>b.textContent="copy",1200);});
document.getElementById("schemas").innerHTML=Object.keys(D.schemas).length?Object.entries(D.schemas).map(([k,v])=>'<div class="card open"><div class="head"><span class="nid">'+esc(k)+'</span></div><div class="body"><pre class="block" style="border:0;margin:0">'+esc(JSON.stringify(v,null,2))+'</pre></div></div>').join(""):'<p style="color:var(--muted)">No structured-output schemas.</p>';
(function(){
  var linkify=function(t){return esc(t).replace(/\((https?:\/\/[^\s)]+)\)/g,'(<a href="$1" target="_blank" rel="noopener">$1</a>)').replace(/(arXiv:[\d.]+)/gi,'<span class="cite">$1</span>');};
  var card=function(name,role,desc){return '<div class="card open"><div class="body" style="display:block;padding:14px 16px"><div class="tname">'+esc(name)+'</div>'+(role?'<div class="trole">'+esc(role)+'</div>':'')+(desc?'<div style="margin-top:6px;color:var(--ink2);font-size:13.5px">'+esc(desc)+'</div>':'')+'</div></div>';};
  var h="";
  if(D.provenance){h+='<div class="prov"><b>Based on</b> '+linkify(D.provenance)+'</div>';}
  if((D.scaffolds||[]).length){h+='<div class="subh">Scaffolds this workflow is based on</div>'+D.scaffolds.map(function(t){return card(t.name||"",t.role||"",t.desc||"");}).join("");}
  if((D.composes||[]).length){h+='<div class="subh">Composes at runtime (workflow())</div>'+D.composes.map(function(c){return card(c,"","");}).join("");}
  if(!D.provenance && !(D.scaffolds||[]).length && !(D.composes||[]).length){h+='<div class="prov" style="color:var(--muted)">No provenance declared for this workflow. Add <code>meta.basedOn</code> (a string, or an array of {name, role, desc}) or a leading <code>// Based on:</code> comment to populate this tab.</div>';}
  if(D.source){h+='<div class="subh">Generated from</div><div class="prov"><code>'+esc(D.source)+'</code></div>';}
  document.getElementById("based").innerHTML=h||'<p style="color:var(--muted)">No provenance recorded.</p>';
})();
document.getElementById("script").textContent=D.script;
document.querySelectorAll("#tabs button").forEach(b=>b.onclick=()=>{document.querySelectorAll("#tabs button").forEach(x=>x.classList.remove("active"));document.querySelectorAll("section").forEach(s=>s.classList.remove("active"));b.classList.add("active");document.querySelector('section[data-s="'+b.dataset.t+'"]').classList.add("active");});
(function(){
  var rt=document.getElementById("tabresults");var rsec=document.querySelector('section[data-s="results"]');
  if(!D.results){if(rt)rt.style.display="none";if(rsec)rsec.style.display="none";return;}
  // Everything renders markdown -> HTML for a consistent look: .md as-is, .json/.txt wrapped in a
  // fenced code block (so marked emits <pre><code class="language-json"> that hljs then highlights).
  // NL/fence via fromCharCode so no backtick or newline needs escaping inside this template literal.
  var NL=String.fromCharCode(10),fence=String.fromCharCode(96,96,96);
  var mdToHtml=function(md){return (window.marked&&marked.parse)?marked.parse(md,{breaks:true}):("<pre>"+esc(md)+"</pre>");};
  // Outputs render as FORMATTED MARKDOWN (auto table/list/kv) via jsonToMarkdown — not raw JSON.
  var toHtml=function(text,ext){
    if(ext==="json"){ try{ return mdToHtml(jsonToMarkdown(JSON.parse(text))); }catch(e){ return mdToHtml(fence+"json"+NL+text+NL+fence); } }
    if(ext==="md"){
      // Engine summaries embed prose then a bare pretty-JSON block (Output: then a { ... } to EOF):
      // render that JSON tail as a markdown table via jsonToMarkdown; fall back to a fenced block.
      var lines=String(text).split(NL),j=-1;
      for(var i=0;i<lines.length;i++){var t=lines[i].trim();if(t==="{"||t==="["){j=i;break;}}
      if(j>=0){ var head=lines.slice(0,j).join(NL), tail=lines.slice(j).join(NL);
        try{ return mdToHtml(head+NL+NL+jsonToMarkdown(JSON.parse(tail))); }catch(e){ return mdToHtml(head+NL+fence+"json"+NL+tail+NL+fence); } }
      return mdToHtml(text);
    }
    return mdToHtml(fence+NL+text+NL+fence);
  };
  var h="";var rv=D.results.returnValue;
  if(rv!==null&&rv!==undefined){h+='<div class="card open"><div class="head"><span class="nid">return value</span><span class="schema">workflow output</span></div><div class="body"><div class="mdbody">'+mdToHtml(typeof rv==="string"?rv:jsonToMarkdown(rv))+'</div></div></div>';}
  (D.results.artifacts||[]).forEach(function(a){h+='<div class="card open"><div class="head"><span class="nid">'+esc(a.name)+'</span><span class="schema">'+esc(a.ext)+'</span></div><div class="body"><div class="mdbody">'+toHtml(a.content,a.ext)+'</div></div></div>';});
  document.getElementById("results").innerHTML=h||'<p style="color:var(--muted)">Run produced no artifacts.</p>';
  try{document.querySelectorAll("#results code").forEach(function(el){hljs.highlightElement(el);});}catch(e){}
})();
try{document.querySelectorAll("#script,#schemas code").forEach(el=>hljs.highlightElement(el));}catch(e){}
