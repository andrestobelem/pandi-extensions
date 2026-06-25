/**
 * Continuous-improvement pass — ONE gated, verified improvement to this package.
 *
 * This is the reusable Pi-native version of the autonomous "improve loop": each run
 * performs exactly ONE high-value improvement (scout -> pick -> implement -> adversarial
 * review -> verify -> log). Loop it by driving repeated runs with the /goal extension
 * (objective: "improve until dry") or by re-running until it reports verdict "dry"/"done".
 *
 * Hard safeguards (baked into the subagent prompts; this workflow is the guardian):
 *  - NEVER edit a "hot" file (one with uncommitted changes you didn't make, or a recent
 *    foreign mtime). For improvements to such files, only PROPOSE in docs/.
 *  - VERIFY before declaring done: `npm test` + esbuild of any touched extension +
 *    `node --check` of any touched example + the relevant e2e. Never leave the tree red.
 *  - No irreversible actions (no push, no rm -rf, no deleting/committing others' work).
 *  - Real value with evidence — no cosmetic "improvement theater".
 *
 * input: { allow?: string[] (glob-ish paths editable, default our extensions+examples+docs),
 *          avoid?: string[] (paths to treat as hot/off-limits, e.g. ["extensions/dynamic-workflows.ts"]),
 *          log?: string (progress-log path, default docs/investigaciones/loop-mejora-continua.md) }
 */
module.exports = async function workflow(ctx, input) {
  const log = input?.log ?? "docs/investigaciones/loop-mejora-continua.md";
  const avoid = input?.avoid ?? ["extensions/dynamic-workflows.ts"];
  const allow = input?.allow ?? ["extensions/loop.ts", "extensions/goal.ts", "extensions/plan.ts", "examples/**", "docs/**"];
  const concurrency = Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency);

  const RULES =
    `Mejorás el paquete de extensiones de Pi. SALVAGUARDAS DURAS:\n` +
    `- NO editar (calientes/ajenos): ${avoid.join(", ")} ni archivos con cambios sin commitear que no hiciste vos ` +
    `(chequeá \`git status --porcelain\` + mtime ANTES de tocar). Para esos, solo PROPONER en docs/.\n` +
    `- Editar permitido solo en: ${allow.join(", ")}. No tocar package.json en autopiloto.\n` +
    `- VERIFICAR antes de dar por bueno: npm test + esbuild de la ext tocada + node --check de examples tocados + e2e relevante. Nada rojo.\n` +
    `- Nada irreversible (no push/rm/borrar/commitear ajeno). No commitees (lo hace quien orquesta).\n` +
    `- Valor real con evidencia; mejor patrón + verificación adversarial.`;

  // 1) SCOUT + PICK + IMPLEMENT one high-value improvement.
  await ctx.log("improve-pass: scouting + picking");
  const impl = await ctx.agent(
    `${RULES}\n\nHacé scout barato (git status/log, npm test baseline, mtime para detectar calientes; revisá el log de progreso ${log} para no repetir). ` +
      `Elegí la ÚNICA mejora de mayor valor/(costo·riesgo) que respete las salvaguardas, IMPLEMENTALA (solo archivos permitidos, ` +
      `re-chequeando cada archivo antes de tocarlo), y dejá el árbol verde. Reportá: mejora elegida, archivos tocados, ` +
      `baseline + verificación (verde/rojo), y evidencia. Si no hay mejora de alto valor segura, decí 'sin-mejora-de-alto-valor' y no toques nada.`,
    { name: "implement", tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
  );

  // 2) ADVERSARIAL REVIEW (parallel): correctness/regression + value/safeguards.
  await ctx.log("improve-pass: adversarial review");
  const reviews = await ctx.parallel([
    () => ctx.agent(
      `${RULES}\n\nREVISOR ADVERSARIAL (correctitud + regresión): revisá el cambio (\`git diff\` de archivos nuestros). ¿Correcto, sin bugs, sin romper nada? ¿npm test y los e2e existentes siguen verdes? Reportá problemas con evidencia archivo:línea + fix; marcá BLOQUEANTES.\n\nCONTEXTO:\n${ctx.compact(impl.output, 3000)}`,
      { name: "review-correctness", tools: ["read", "grep", "find", "ls", "bash"] },
    ),
    () => ctx.agent(
      `${RULES}\n\nREVISOR ADVERSARIAL (valor + salvaguardas): ¿el cambio tiene VALOR REAL (no cosmético)? ¿respetó las salvaguardas (no calientes, solo permitidos, sin irreversibles, sin package.json)? ¿\`git status\` muestra solo archivos permitidos? Reportá problemas + fix; marcá BLOQUEANTES.\n\nCONTEXTO:\n${ctx.compact(impl.output, 3000)}`,
      { name: "review-value", tools: ["read", "grep", "find", "ls", "bash"] },
    ),
  ]);

  // 3) FIX blockers + VERIFY green + LOG + final verdict.
  await ctx.log("improve-pass: verify + log");
  const verify = await ctx.agent(
    `${RULES}\n\nFINALIZÁ LA PASADA. 1) Aplicá los fixes BLOQUEANTES de las revisiones (solo archivos permitidos). ` +
      `2) VERIFICÁ verde: npm test + esbuild de la ext tocada + node --check de examples tocados + e2e relevante (y los e2e previos, sin regresión); si algo rompe, corregí o revertí TU cambio. ` +
      `3) Append una entrada al log ${log} (fecha, mejora, archivos, verificación, evidencia). ` +
      `4) REPORTE final: mejora + archivos; verificación (verde/rojo) de cada chequeo; \`git status --porcelain\`; ` +
      `VEREDICTO: continue | done | blocked + por qué (si no hubo mejora, 'dry'); 1-2 pendientes para la próxima pasada.\n\n` +
      `REVISIONES:\n${reviews.filter(Boolean).map((r, i) => `--- R${i} ---\n${ctx.compact(r.output, 2500)}`).join("\n\n")}`,
    { name: "verify-log", tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
  );

  await ctx.writeArtifact("improve-pass.json", { impl: impl.output, reviews: reviews.map((r) => r?.output), verify: verify.output });
  return verify.output;
};
