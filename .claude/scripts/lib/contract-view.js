// contract-view.js — client-side renderer for a Contract Gate result, INJECTED into the artifact
// HTML only when a contract is present (so non-contract artifacts stay byte-identical). It runs in
// the same <script> scope as artifact-client.js, so `D`, `esc`, and `marked` are already in scope.
// Renders improvedTask, successCriteria, assumptions (confidence + invalidatedBy), nonGoals,
// constraints, routing, verificationPlan, and blockers as formatted markdown. Field names tolerate
// both this repo's lean gate (routingHints/blockers) and the full contract-gate scaffold
// (routingHint/ambiguities).
function contractMd(c){
  var NL=String.fromCharCode(10);
  var routing=c.routingHints||c.routingHint||{};
  var blockers=Array.isArray(c.blockers)?c.blockers:((c.ambiguities||[]).filter(function(a){return a&&a.blocking;}).map(function(a){return {question:a.question,rationale:a.rationale};}));
  var s="";
  s+="**Tarea:** "+(c.improvedTask||"")+NL+NL;
  s+="## Criterios de éxito"+NL+(c.successCriteria||[]).map(function(x){return "- [ ] "+x;}).join(NL)+NL+NL;
  if((c.assumptions||[]).length) s+="## Supuestos"+NL+c.assumptions.map(function(a){return typeof a==="string"?("- "+a):("- ("+(a.confidence||"?")+") "+(a.assumption||"")+(a.invalidatedBy?" — *invalidado por:* "+a.invalidatedBy:""));}).join(NL)+NL+NL;
  if((c.nonGoals||[]).length) s+="## Fuera de alcance"+NL+c.nonGoals.map(function(x){return "- "+x;}).join(NL)+NL+NL;
  if((c.constraints||[]).length) s+="## Restricciones"+NL+c.constraints.map(function(x){return "- "+x;}).join(NL)+NL+NL;
  if(routing&&routing.shape) s+="## Ruteo"+NL+"- shape: **"+routing.shape+"** · pattern: "+routing.pattern+" · maxAgents~"+routing.maxAgents+" · concurrency: "+routing.concurrency+NL+(routing.rationale?"- "+routing.rationale+NL:"")+NL;
  if(c.verificationPlan) s+="## Plan de verificación"+NL+c.verificationPlan+NL+NL;
  s+="## Bloqueos"+NL+(blockers.length?blockers.map(function(b){return "- **"+(b.question||"")+"**"+(b.rationale?" — "+b.rationale:"");}).join(NL):"_ninguno — se puede avanzar_")+NL;
  return s;
}
if(D.contract){var cEl=document.getElementById("contract");if(cEl){var safeMd=escapeMarkdownHtml(contractMd(D.contract));var html=(window.marked&&marked.parse)?marked.parse(safeMd,{breaks:true}):("<pre>"+esc(JSON.stringify(D.contract,null,2))+"</pre>");cEl.innerHTML=sanitizeRenderedHtml(html);}}
