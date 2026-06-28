import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const normalizeRepoPath = (value) =>
  String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");

// Deliberately small glob dialect: only `*` and `**` are wildcards; `?`/`[]` stay literal.
const hasGlob = (pattern) => String(pattern || "").includes("*");

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const globRegexCache = new Map();
const globToRegex = (pattern) => {
  const normalized = normalizeRepoPath(pattern);
  let cached = globRegexCache.get(normalized);
  if (cached) return cached;

  let source = "";
  for (let i = 0; i < normalized.length; ) {
    if (normalized.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
    } else if (normalized.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else if (normalized[i] === "*") {
      source += "[^/]*";
      i += 1;
    } else {
      source += escapeRegex(normalized[i]);
      i += 1;
    }
  }
  cached = new RegExp(`^${source}$`);
  globRegexCache.set(normalized, cached);
  return cached;
};

const matchesPattern = (repoPath, pattern) => {
  const rel = normalizeRepoPath(repoPath);
  const normalizedPattern = normalizeRepoPath(pattern);
  if (!rel || !normalizedPattern) return false;
  if (!hasGlob(normalizedPattern)) return rel === normalizedPattern;
  if (normalizedPattern.endsWith("/**")) {
    const base = normalizedPattern.slice(0, -3);
    if (rel === base || rel.startsWith(`${base}/`)) return true;
  }
  return globToRegex(normalizedPattern).test(rel);
};

const matchesAny = (repoPath, patterns) => patterns.some((pattern) => matchesPattern(repoPath, pattern));

const parsePorcelainZ = (stdout) => {
  const entries = String(stdout || "").split("\0").filter(Boolean);
  const files = new Map();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const rel = normalizeRepoPath(entry.slice(3));
    if (rel) files.set(rel, status);
    if (status[0] === "R" || status[0] === "C") {
      const source = normalizeRepoPath(entries[++i] || "");
      if (source) files.set(source, status);
    }
  }
  return files;
};

const fingerprintPath = (repoPath) => {
  const absPath = path.resolve(repoPath);
  let stat;
  try {
    stat = fs.lstatSync(absPath);
  } catch {
    return { exists: false };
  }

  const fingerprint = {
    exists: true,
    type: stat.isFile() ? "file" : stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "other",
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
  if (stat.isFile()) {
    fingerprint.sha256 = createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
  } else if (stat.isSymbolicLink()) {
    try {
      fingerprint.link = fs.readlinkSync(absPath);
    } catch {
      fingerprint.link = null;
    }
  }
  return fingerprint;
};

const collectSafetySnapshot = async (ctx, extraPaths = []) => {
  const status = await ctx.bash("git status --porcelain=v1 -z --untracked-files=all", { timeoutMs: 60000 });
  if (!status.ok) throw new Error(`git status failed while collecting safety snapshot (exit ${status.code})`);
  const head = await ctx.bash("git rev-parse --verify HEAD", { timeoutMs: 60000 });

  const statusFiles = parsePorcelainZ(status.stdout);
  const paths = new Set(statusFiles.keys());
  for (const repoPath of extraPaths.map(normalizeRepoPath)) {
    if (repoPath && !hasGlob(repoPath)) paths.add(repoPath);
  }

  const files = {};
  for (const repoPath of [...paths].sort()) {
    files[repoPath] = {
      status: statusFiles.get(repoPath) || "clean",
      ...fingerprintPath(repoPath),
    };
  }
  return { head: head.ok ? String(head.stdout || "").trim() : null, files };
};

const sameFingerprint = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const formatPathList = (paths, limit = 40) => {
  if (!paths.length) return "(ninguno)";
  const sorted = [...paths].sort();
  const shown = sorted.slice(0, limit).join(", ");
  return sorted.length > limit ? `${shown}, … (+${sorted.length - limit})` : shown;
};

const runSafetyGate = async (ctx, baseline, { allow, hotFiles }) => {
  const current = await collectSafetySnapshot(ctx, [...Object.keys(baseline.files), ...hotFiles]);
  const problems = [];

  if (baseline.head !== current.head) {
    problems.push(`git HEAD changed during the pass: ${baseline.head || "(none)"} -> ${current.head || "(none)"}`);
  }

  for (const [repoPath, before] of Object.entries(baseline.files)) {
    const after = current.files[repoPath] || { status: "clean", ...fingerprintPath(repoPath) };
    if (!sameFingerprint(before, after)) {
      problems.push(`pre-existing/protected file changed during the pass: ${repoPath}`);
    }
  }

  for (const [repoPath, after] of Object.entries(current.files)) {
    if (after.status === "clean" || Object.prototype.hasOwnProperty.call(baseline.files, repoPath)) continue;
    if (matchesAny(repoPath, hotFiles)) {
      problems.push(`hot file changed: ${repoPath}`);
    } else if (!matchesAny(repoPath, allow)) {
      problems.push(`changed file outside allowlist: ${repoPath}`);
    }
  }

  const changedFiles = Object.entries(current.files)
    .filter(([, file]) => file.status !== "clean")
    .map(([repoPath]) => repoPath)
    .sort();

  return { ok: problems.length === 0, problems, changedFiles };
};

/**
 * continuous-improvement — a SELF-CONTAINED, project-local continuous-improvement LOOP.
 *
 * Separate from the `/goal` extension (which is generic and untouched): this is a dynamic
 * workflow you run on demand to TEST the improvement cycle. It loops up to `maxPasses`:
 *   meta-step (refine the raw objective into a sharp driving prompt)  -- once, up front
 *   then per pass: implement ONE safe improvement -> adversarial review -> VERIFY green -> log
 * It STOPS early when a pass is DRY (nothing safe left) or BLOCKED (needs a human).
 *
 * The CHECKS drive the loop, not the agent's self-report: after each pass the workflow runs
 * machine safety gates before and after `verifyCmd`; a RED check forces BLOCKED regardless
 * of what the agent claimed.
 *
 * Hard safeguards (baked into prompts and checked before/after verification; this workflow is the guardian):
 *  - NEVER edit a hot/foreign file: `hotFiles` (default extensions/pi-dynamic-workflows/index.ts) or any
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
  const logPath = input.logPath || "docs/research/continuous-improvement-log.md";
  const backlogPath = input.backlogPath || "docs/research/continuous-improvement-backlog.md";
  const hotFiles = input.hotFiles || ["extensions/pi-dynamic-workflows/index.ts"];
  const allow = input.allow || [
    "extensions/pi-loop/**",
    "extensions/pi-goal/**",
    "extensions/pi-plan/**",
    "extensions/pi-bg/**",
    "extensions/pi-effort/**",
    "scripts/test/run-all.mjs",
    "docs/**",
  ];
  const verifyCmd = input.verifyCmd || "npm test";

  const parseVerdict = (text) => {
    const lines = String(text || "").trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/VERDICT:\s*(CONTINUE|DRY|BLOCKED)/i);
      if (m) return m[1].toUpperCase();
    }
    return "BLOCKED"; // no parseable verdict -> conservative stop, never a blind continue
  };

  const summarizePass = (p) => {
    const green = p.green === null ? " (verify skipped)" : p.green ? "" : " (RED)";
    return `pass ${p.pass}: ${p.verdict}${green}${p.safe ? "" : " (safety BLOCKED)"}`;
  };

  const safetyBaseline = await collectSafetySnapshot(ctx, hotFiles);
  const dirtyAtStart = Object.entries(safetyBaseline.files)
    .filter(([, file]) => file.status !== "clean")
    .map(([repoPath]) => repoPath)
    .sort();
  const dirtyAtStartSet = new Set(dirtyAtStart);
  const normalizedLogPath = normalizeRepoPath(logPath);
  const canAppendLog =
    matchesAny(normalizedLogPath, allow) && !matchesAny(normalizedLogPath, hotFiles) && !dirtyAtStartSet.has(normalizedLogPath);
  const logInstruction = canAppendLog
    ? `3) Append una entrada BREVE y cronológica a ${logPath} (fecha, mejora, archivos REALES tocados, verificación, evidencia). Solo la narrativa de ESTE pass; los PENDIENTES no van acá, van al backlog.`
    : `3) NO edites ${logPath} (no está permitido, está caliente o ya tenía cambios al iniciar); incluí la entrada de log sugerida en el reporte.`;
  const normalizedBacklogPath = normalizeRepoPath(backlogPath);
  const canUpdateBacklog =
    matchesAny(normalizedBacklogPath, allow) && !matchesAny(normalizedBacklogPath, hotFiles) && !dirtyAtStartSet.has(normalizedBacklogPath);
  const backlogInstruction = canUpdateBacklog
    ? `3b) Actualizá el BACKLOG canónico de pendientes en ${backlogPath} (ESTE es el lugar de los pendientes, NO el log): agregá los items nuevos abiertos y marcá DONE los que este pass resolvió, sin duplicar. ` +
      `Cada item lleva id estable, título, por qué, rutas REALES (verificá con ls/read que existen; no cites rutas viejas) y estado (open/done/human).`
    : `3b) NO edites ${backlogPath} (no está permitido, está caliente o ya tenía cambios al iniciar); incluí los items de backlog sugeridos en el reporte.`;

  const RULES =
    `Mejorás este paquete de extensiones de Pi. SALVAGUARDAS DURAS:\n` +
    `- NO editar (calientes/ajenos): ${hotFiles.join(", ")} ni archivos con cambios sin commitear que no hiciste vos ` +
    `(chequeá \`git status --porcelain\` + mtime ANTES de tocar). Para esos, solo PROPONER en docs/.\n` +
    `- Cambios al iniciar tratados como ajenos/no tocar: ${formatPathList(dirtyAtStart)}.\n` +
    `- Editar permitido SOLO en: ${allow.join(", ")}. No tocar package.json en autopiloto.\n` +
    `- Tests durables bajo tests/** deben quedar reflejados en scripts/test/run-all.mjs si ese manifest está clean/permitido; si no, no agregues suites nuevas.\n` +
    `- Gate automático antes/después de verify: BLOCKED si cambia HEAD, un archivo caliente/sucio al iniciar, o aparece un cambio fuera de allow.\n` +
    `- VERIFICAR verde: ${verifyCmd} + esbuild de la ext tocada + node --check de JS/MJS tocados + e2e relevante. Nada rojo.\n` +
    `- NADA irreversible: no push, no rm -rf, no borrar/commitear ajeno. NO commitees (el commit lo hace el humano tras revisar).\n` +
    `- Valor real con evidencia; mejor patrón + verificación adversarial.`;

  // ---- META-STEP (phase 0): refine the raw objective into a sharp driving prompt. ----
  await ctx.log("continuous-improvement: meta-step — refining the driving prompt");
  const scout0 = await ctx.bash(
    `git status --short; echo '--- recent ---'; git log --oneline -6; echo '--- log tail ---'; ` +
      `test -f ${JSON.stringify(logPath)} && tail -60 ${JSON.stringify(logPath)} || true; ` +
      `echo '--- backlog (pendientes abiertos) ---'; test -f ${JSON.stringify(backlogPath)} && cat ${JSON.stringify(backlogPath)} || true`,
    { timeoutMs: 60000 },
  );
  const meta = await ctx.agent(
    `${RULES}\n\nMETA-PASO (read-only): afiná este OBJETIVO CRUDO en un PROMPT DE MANEJO nítido para el loop de mejora.\n` +
      `Objetivo crudo: ${rawObjective}\n\nEvidencia del repo:\n${ctx.compact(scout0.stdout, 4000)}\n\n` +
      `Escaneá el repo (read-only, no modifiques nada) y producí un driving prompt con estas secciones FIJAS, basadas en lo que EXISTE (no inventes):\n` +
      `Objetivo afinado:\nCriterios de done (definición de terminado):\nArchivos permitidos:\nArchivos calientes/prohibidos (no tocar): ${formatPathList([...new Set([...hotFiles, ...dirtyAtStart])])} (sumá los que detectes con cambios sin commitear ajenos)\n` +
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
      `${RULES}\n\nDRIVING PROMPT:\n${drivingPrompt}\n\nPASS ${pass}/${maxPasses}. Scout barato (git status/diff, baseline si hace falta, y los items abiertos del backlog ${backlogPath}), ` +
        `elegí la ÚNICA mejora de mayor valor/(costo·riesgo) que respete las salvaguardas (preferí un item abierto del backlog si aplica), IMPLEMENTALA solo en archivos permitidos ` +
        `(re-chequeá cada archivo ANTES de tocarlo), y dejá el árbol verde. Si no hay mejora segura de alto valor, NO toques nada y decí 'sin-mejora-segura'. ` +
        `Reportá: mejora elegida, archivos tocados, evidencia.`,
      { name: `implement-${pass}`, tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
    );

    const safetyAfterImplement = await runSafetyGate(ctx, safetyBaseline, { allow, hotFiles });
    await ctx.writeArtifact(`safety-after-implement-${pass}.json`, JSON.stringify(safetyAfterImplement, null, 2));
    if (!safetyAfterImplement.ok) {
      await ctx.log(
        `continuous-improvement: pass ${pass} — safety gate BLOCKED before review/verify:\n${safetyAfterImplement.problems
          .map((problem) => `- ${problem}`)
          .join("\n")}`,
      );
      verdict = "BLOCKED";
      await ctx.writeArtifact(
        `safety-pass-${pass}.json`,
        JSON.stringify({ afterImplement: safetyAfterImplement, beforeVerify: null, afterVerify: null }, null, 2),
      );
      passes.push({ pass, verdict, green: null, safe: false, impl: impl.output, verify: "" });
      await ctx.log(`continuous-improvement: ${summarizePass(passes[passes.length - 1])}`);
      continue;
    }

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
            `¿\`git status --porcelain\` muestra solo cambios nuevos permitidos y los archivos sucios al iniciar siguen intactos? Problemas + fix; marcá BLOQUEANTES.\n\nCONTEXTO:\n${ctx.compact(impl.output, 3000)}`,
          { name: `review-value-${pass}`, tools: ["read", "grep", "find", "ls", "bash"] },
        ),
    ]);

    await ctx.log(`continuous-improvement: pass ${pass} — finalize + gated verify`);
    const verify = await ctx.agent(
      `${RULES}\n\nFINALIZÁ EL PASS. 1) Aplicá los fixes BLOQUEANTES de las revisiones (solo archivos permitidos). ` +
        `2) Dejá el árbol listo para que el orquestador verifique; NO ejecutes ${verifyCmd} ni otros comandos de test aquí. ` +
        `${logInstruction} ${backlogInstruction} 4) NO commitees. ` +
        `REPORTE final y en la ÚLTIMA línea EXACTAMENTE uno de:\n` +
        `VERDICT: CONTINUE  (implementaste una mejora verificada y puede quedar más)\n` +
        `VERDICT: DRY       (no queda mejora segura de alto valor)\n` +
        `VERDICT: BLOCKED   (necesita una decisión humana)\n\n` +
        `DRIVING PROMPT:\n${drivingPrompt}\n\nREVISIONES:\n` +
        reviews.filter(Boolean).map((r, i) => `--- R${i} ---\n${ctx.compact(r.output, 2500)}`).join("\n\n"),
      { name: `verify-${pass}`, tools: ["read", "grep", "find", "ls", "edit", "write"] },
    );

    // The CHECKS drive the loop: safety gate before verifyCmd, verifyCmd, then safety gate again.
    const safetyBeforeVerify = await runSafetyGate(ctx, safetyBaseline, { allow, hotFiles });
    await ctx.writeArtifact(`safety-before-verify-${pass}.json`, JSON.stringify(safetyBeforeVerify, null, 2));
    verdict = parseVerdict(verify.output);

    let check = { ok: false, code: "skipped" };
    let safetyAfterVerify = safetyBeforeVerify;
    if (!safetyBeforeVerify.ok) {
      await ctx.log(
        `continuous-improvement: pass ${pass} — safety gate BLOCKED before ${verifyCmd}:\n${safetyBeforeVerify.problems
          .map((problem) => `- ${problem}`)
          .join("\n")}`,
      );
      verdict = "BLOCKED";
    } else {
      check = await ctx.bash(verifyCmd, { timeoutMs: input.verifyTimeoutMs || 600000 });
      safetyAfterVerify = await runSafetyGate(ctx, safetyBaseline, { allow, hotFiles });
      await ctx.writeArtifact(`safety-after-verify-${pass}.json`, JSON.stringify(safetyAfterVerify, null, 2));
      if (!safetyAfterVerify.ok) {
        await ctx.log(
          `continuous-improvement: pass ${pass} — safety gate BLOCKED after ${verifyCmd}:\n${safetyAfterVerify.problems
            .map((problem) => `- ${problem}`)
            .join("\n")}`,
        );
        verdict = "BLOCKED";
      }
      if (!check.ok) {
        await ctx.log(`continuous-improvement: pass ${pass} — ${verifyCmd} RED (exit ${check.code}) → BLOCKED (tree not left green)`);
        verdict = "BLOCKED";
      }
    }

    const safe = safetyAfterImplement.ok && safetyBeforeVerify.ok && safetyAfterVerify.ok;
    await ctx.writeArtifact(
      `safety-pass-${pass}.json`,
      JSON.stringify({ afterImplement: safetyAfterImplement, beforeVerify: safetyBeforeVerify, afterVerify: safetyAfterVerify }, null, 2),
    );
    passes.push({ pass, verdict, green: safetyBeforeVerify.ok ? check.ok : null, safe, impl: impl.output, verify: verify.output });
    await ctx.log(`continuous-improvement: ${summarizePass(passes[passes.length - 1])}`);
  }

  await ctx.writeArtifact(
    "continuous-improvement.json",
    JSON.stringify(
      {
        rawObjective,
        maxPasses,
        drivingPrompt,
        passes: passes.map((p) => ({ pass: p.pass, verdict: p.verdict, green: p.green, safe: p.safe })),
      },
      null,
      2,
    ),
  );
  await ctx.log(`continuous-improvement: done — ${passes.length} pass(es), final ${verdict}. Review the diff and COMMIT yourself.`);
  return {
    passesRun: passes.length,
    finalVerdict: verdict,
    drivingPrompt,
    summary: passes.map(summarizePass).join("; "),
    note: "Working tree has uncommitted edits. Review and commit manually; this loop never commits or pushes.",
  };
}
