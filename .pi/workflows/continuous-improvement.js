/**
 * continuous-improvement — a SELF-CONTAINED, project-local continuous-improvement LOOP.
 *
 * Separate from the `/goal` extension (which is generic and untouched): this is a dynamic
 * workflow you run on demand to TEST the improvement cycle. It loops up to `maxPasses`:
 *   meta-step (refine the raw objective into a sharp driving prompt)  -- once, up front
 *   then per pass: implement ONE safe improvement -> adversarial review -> VERIFY green -> log
 * It STOPS early when a pass is DRY (nothing safe left) or BLOCKED (needs a human).
 *
 * The CHECK drives the loop, not the agent's self-report: after each pass the workflow runs
 * `verifyCmd` itself; a RED tree forces BLOCKED regardless of what the agent claimed.
 *
 * Hard safeguards (baked into the agent prompts; this workflow is the guardian):
 *  - NEVER edit a hot/foreign file: `hotFiles` (default extensions/dynamic-workflows.ts) or any
 *    file with uncommitted changes you did not make (check `git status` + mtime BEFORE editing).
 *    For those, only PROPOSE in docs/.
 *  - Edit ONLY within `allow`. Leave the tree GREEN (verifyCmd + esbuild/node --check/e2e).
 *  - NOTHING irreversible: no push, no rm -rf, no deleting/committing others' work.
 *  - DO NOT commit — the human commits after review.
 *
 * Run it (from the repo root, project trusted):
 *   /workflow run continuous-improvement {"maxPasses":3}
 *
 * Input: { objective?, maxPasses?=3, logPath?, hotFiles?=[...], allow?=[...], verifyCmd?="npm test" }
 */
export default async function workflow(ctx, input = {}) {
  const rawObjective =
    input.objective ||
    "Mejorá este paquete de extensiones Pi: UNA mejora segura de alto valor por iteración hasta que no quede ninguna (dry).";
  const maxPasses = input.maxPasses || 3;
  const logPath = input.logPath || "docs/investigaciones/continuous-improvement-log.md";
  const hotFiles = input.hotFiles || ["extensions/dynamic-workflows.ts"];
  const allow = input.allow || ["extensions/loop.ts", "extensions/goal.ts", "extensions/plan.ts", "examples/**", "docs/**"];
  const verifyCmd = input.verifyCmd || "npm test";

  const parseVerdict = (text) => {
    const lines = String(text || "").trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/VERDICT:\s*(CONTINUE|DRY|BLOCKED)/i);
      if (m) return m[1].toUpperCase();
    }
    return "BLOCKED"; // no parseable verdict -> conservative stop, never a blind continue
  };

  const RULES =
    `Mejorás este paquete de extensiones de Pi. SALVAGUARDAS DURAS:\n` +
    `- NO editar (calientes/ajenos): ${hotFiles.join(", ")} ni archivos con cambios sin commitear que no hiciste vos ` +
    `(chequeá \`git status --porcelain\` + mtime ANTES de tocar). Para esos, solo PROPONER en docs/.\n` +
    `- Editar permitido SOLO en: ${allow.join(", ")}. No tocar package.json en autopiloto.\n` +
    `- VERIFICAR verde: ${verifyCmd} + esbuild de la ext tocada + node --check de los examples tocados + e2e relevante. Nada rojo.\n` +
    `- NADA irreversible: no push, no rm -rf, no borrar/commitear ajeno. NO commitees (el commit lo hace el humano tras revisar).\n` +
    `- Valor real con evidencia; mejor patrón + verificación adversarial.`;

  // ---- META-STEP (phase 0): refine the raw objective into a sharp driving prompt. ----
  await ctx.log("continuous-improvement: meta-step — refining the driving prompt");
  const scout0 = await ctx.bash(
    `git status --short; echo '--- recent ---'; git log --oneline -6; echo '--- log tail ---'; ` +
      `test -f ${JSON.stringify(logPath)} && tail -60 ${JSON.stringify(logPath)} || true`,
    { timeoutMs: 60000 },
  );
  const meta = await ctx.agent(
    `${RULES}\n\nMETA-PASO (read-only): afiná este OBJETIVO CRUDO en un PROMPT DE MANEJO nítido para el loop de mejora.\n` +
      `Objetivo crudo: ${rawObjective}\n\nEvidencia del repo:\n${ctx.compact(scout0.stdout, 4000)}\n\n` +
      `Escaneá el repo (read-only, no modifiques nada) y producí un driving prompt con estas secciones FIJAS, basadas en lo que EXISTE (no inventes):\n` +
      `Objetivo afinado:\nCriterios de done (definición de terminado):\nArchivos permitidos:\nArchivos calientes/prohibidos (no tocar): ${hotFiles.join(", ")} (sumá los que detectes con cambios sin commitear ajenos)\n` +
      `Comandos de verificación:\nSalvaguardas:`,
    { name: "meta-refine", tools: ["read", "grep", "find", "ls", "bash"] },
  );
  const drivingPrompt = meta.output || String(meta);
  await ctx.writeArtifact("driving-prompt.md", drivingPrompt);

  // ---- LOOP: implement -> adversarial review -> verify (objective check gates the verdict). ----
  const passes = [];
  let verdict = "CONTINUE";
  for (let pass = 1; pass <= maxPasses && verdict === "CONTINUE"; pass++) {
    await ctx.log(`continuous-improvement: pass ${pass}/${maxPasses} — implement`);
    const impl = await ctx.agent(
      `${RULES}\n\nDRIVING PROMPT:\n${drivingPrompt}\n\nPASS ${pass}/${maxPasses}. Scout barato (git status/diff, baseline si hace falta), ` +
        `elegí la ÚNICA mejora de mayor valor/(costo·riesgo) que respete las salvaguardas, IMPLEMENTALA solo en archivos permitidos ` +
        `(re-chequeá cada archivo ANTES de tocarlo), y dejá el árbol verde. Si no hay mejora segura de alto valor, NO toques nada y decí 'sin-mejora-segura'. ` +
        `Reportá: mejora elegida, archivos tocados, evidencia.`,
      { name: `implement-${pass}`, tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
    );

    await ctx.log(`continuous-improvement: pass ${pass} — adversarial review`);
    const reviews = await ctx.parallel([
      () =>
        ctx.agent(
          `${RULES}\n\nREVISOR ADVERSARIAL (correctitud + regresión): revisá \`git diff\` de archivos nuestros. ¿Correcto, sin bugs, sin romper nada? ` +
            `¿${verifyCmd} y los e2e existentes siguen verdes? Problemas con evidencia archivo:línea + fix; marcá BLOQUEANTES.\n\nCONTEXTO:\n${ctx.compact(impl.output, 3000)}`,
          { name: `review-correctness-${pass}`, tools: ["read", "grep", "find", "ls", "bash"] },
        ),
      () =>
        ctx.agent(
          `${RULES}\n\nREVISOR ADVERSARIAL (valor + salvaguardas): ¿valor REAL (no cosmético)? ¿respetó las salvaguardas (no calientes/ajenos, solo permitidos, sin commit/push)? ` +
            `¿\`git status --porcelain\` muestra SOLO archivos permitidos? Problemas + fix; marcá BLOQUEANTES.\n\nCONTEXTO:\n${ctx.compact(impl.output, 3000)}`,
          { name: `review-value-${pass}`, tools: ["read", "grep", "find", "ls", "bash"] },
        ),
    ]);

    await ctx.log(`continuous-improvement: pass ${pass} — verify + log`);
    const verify = await ctx.agent(
      `${RULES}\n\nFINALIZÁ EL PASS. 1) Aplicá los fixes BLOQUEANTES de las revisiones (solo archivos permitidos). ` +
        `2) VERIFICÁ verde: ${verifyCmd} + esbuild de la ext tocada + node --check de los examples tocados + e2e relevante; si algo rompe, corregí o revertí TU cambio. ` +
        `3) Append una entrada a ${logPath} (fecha, mejora, archivos, verificación, evidencia). 4) NO commitees. ` +
        `REPORTE final y en la ÚLTIMA línea EXACTAMENTE uno de:\n` +
        `VERDICT: CONTINUE  (implementaste una mejora verificada y puede quedar más)\n` +
        `VERDICT: DRY       (no queda mejora segura de alto valor)\n` +
        `VERDICT: BLOCKED   (necesita una decisión humana)\n\n` +
        `DRIVING PROMPT:\n${drivingPrompt}\n\nREVISIONES:\n` +
        reviews.filter(Boolean).map((r, i) => `--- R${i} ---\n${ctx.compact(r.output, 2500)}`).join("\n\n"),
      { name: `verify-${pass}`, tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
    );

    // The CHECK drives the loop: run verifyCmd ourselves; a RED tree forces BLOCKED.
    const check = await ctx.bash(verifyCmd, { timeoutMs: input.verifyTimeoutMs || 600000 });
    verdict = parseVerdict(verify.output);
    if (!check.ok) {
      await ctx.log(`continuous-improvement: pass ${pass} — ${verifyCmd} RED (exit ${check.code}) → BLOCKED (tree not left green)`);
      verdict = "BLOCKED";
    }
    passes.push({ pass, verdict, green: check.ok, impl: impl.output, verify: verify.output });
    await ctx.log(`continuous-improvement: pass ${pass} → ${verdict}${check.ok ? " (green)" : " (RED)"}`);
  }

  await ctx.writeArtifact(
    "continuous-improvement.json",
    JSON.stringify(
      { rawObjective, maxPasses, drivingPrompt, passes: passes.map((p) => ({ pass: p.pass, verdict: p.verdict, green: p.green })) },
      null,
      2,
    ),
  );
  await ctx.log(`continuous-improvement: done — ${passes.length} pass(es), final ${verdict}. Review the diff and COMMIT yourself.`);
  return {
    passesRun: passes.length,
    finalVerdict: verdict,
    drivingPrompt,
    summary: passes.map((p) => `pass ${p.pass}: ${p.verdict}${p.green ? "" : " (RED)"}`).join("; "),
    note: "Working tree has uncommitted edits. Review and commit manually; this loop never commits or pushes.",
  };
}
