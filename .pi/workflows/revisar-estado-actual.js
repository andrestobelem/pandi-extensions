module.exports = async function workflow(ctx, input) {
  const maxFiles = Number(input?.maxFiles ?? 2000);
  const concurrency = Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency);
  const runChecks = Boolean(input?.runChecks ?? false);
  const agentTimeoutMs = input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs;

  await ctx.log("revisar-estado-actual:start", { input, maxFiles, concurrency, runChecks });

  const runCommand = async (name, command, options = {}) => {
    const result = await ctx.bash(command, {
      timeoutMs: options.timeoutMs ?? 20_000,
      throwOnError: false,
    });
    return {
      name,
      command,
      ok: result.ok,
      code: result.code,
      killed: result.killed,
      elapsedMs: result.elapsedMs,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };

  const safeJson = async (file) => {
    try {
      return JSON.parse(await ctx.readFile(file));
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  };

  const baselineCommands = [
    ["git-status", "git status --short --branch"],
    ["git-log", "git log --oneline --decorate -8"],
    ["git-diff-stat", "git diff --stat && git diff --cached --stat"],
    ["tracked-files", "git ls-files | sort | head -400"],
    ["untracked-files", "git ls-files --others --exclude-standard | sort | head -200"],
    ["tree", "find . -type f ! -path './.git/*' | sort | head -500"],
    ["todos", "rg -n \"TODO|FIXME|XXX|HACK|BUG\" . --glob '!.git/**' --glob '!node_modules/**' || true"],
  ];

  const baseline = {
    cwd: ctx.cwd,
    runId: ctx.runId,
    collectedAt: new Date().toISOString(),
    packageJson: await safeJson("package.json"),
    commands: [],
    checks: [],
  };

  for (const [name, command] of baselineCommands) {
    await ctx.log("collecting baseline", { name });
    baseline.commands.push(await runCommand(name, command));
  }

  const packageScripts = baseline.packageJson?.scripts ?? {};
  const checkScripts = ["lint", "typecheck", "test", "build"].filter((script) => packageScripts[script]);
  if (runChecks && checkScripts.length > 0) {
    for (const script of checkScripts) {
      await ctx.log("running package check", { script });
      baseline.checks.push(await runCommand(`npm-run-${script}`, `npm run ${script}`, { timeoutMs: input?.checkTimeoutMs ?? 120_000 }));
    }
  } else {
    baseline.checks.push({
      name: "package-checks",
      skipped: true,
      reason: runChecks ? "No package scripts found for lint/typecheck/test/build." : "Set input.runChecks=true to run package scripts.",
      availableScripts: Object.keys(packageScripts),
    });
  }

  const allFiles = await ctx.listFiles(".", { maxFiles });
  const relevantFiles = allFiles
    .filter((file) =>
      file === "package.json" ||
      file === "README.md" ||
      file === "LICENSE" ||
      file === ".gitignore" ||
      file === "skills/dynamic-workflows/SKILL.md" ||
      file === "extensions/dynamic-workflows.ts" ||
      /^examples\/workflows\/.*\.js$/.test(file) ||
      /^\.pi\/workflows\/.*\.js$/.test(file),
    )
    .sort();

  await ctx.writeArtifact("baseline.json", baseline);
  await ctx.writeArtifact("relevant-files.json", relevantFiles);
  await ctx.log("baseline collected", { relevantFileCount: relevantFiles.length });

  const snapshot = ctx.compact({ baseline, relevantFiles }, 45_000);

  const groups = [
    {
      name: "git-y-estructura",
      files: relevantFiles,
      focus: "estado del working tree, archivos nuevos/modificados, estructura del proyecto, coherencia entre inventario y package.json",
    },
    {
      name: "implementacion-runtime",
      files: relevantFiles.filter((file) => file.startsWith("extensions/") || file.startsWith(".pi/workflows/")),
      focus: "estado de la implementacion TypeScript/JavaScript, riesgos tecnicos, TODOs, seguridad, limites, errores probables",
    },
    {
      name: "docs-skill-ejemplos",
      files: relevantFiles.filter((file) => file === "README.md" || file === "package.json" || file.startsWith("skills/") || file.startsWith("examples/")),
      focus: "documentacion, skill, ejemplos, instalacion, manifest de package, consistencia con el comportamiento esperado",
    },
    {
      name: "verificacion-y-siguientes-pasos",
      files: relevantFiles,
      focus: "scripts/tests disponibles o faltantes, checks ejecutados u omitidos, riesgos de release, proximas acciones priorizadas",
    },
  ];

  const reviews = await ctx.agents(
    groups.map((group) => ({
      name: group.name,
      prompt: `Revisa el estado actual de este repositorio de forma enfocada.

Patrón de trabajo: fan-out independiente. Tu reporte será sintetizado por otro agente; no asumas que otros cubrirán huecos. No edites archivos.

Foco: ${group.focus}

Archivos relevantes sugeridos:
${group.files.map((file) => `- ${file}`).join("\n") || "- Sin archivos especificos; usa el snapshot y descubre archivos con ls/find."}

Snapshot inicial:
${snapshot}

Reglas de evidencia:
- Usa solo evidencia del repositorio y del snapshot.
- Cita archivos y lineas cuando hagas hallazgos concretos.
- Distingue hechos, riesgos y suposiciones.
- No conviertas estilo/preferencias en bloqueadores.
- Si no hay hallazgos importantes, di NO_FINDINGS para esa categoría.

Formato obligatorio:
## Veredicto
## Hallazgos confirmados
- [Severidad: Alta/Media/Baja] título — evidencia — impacto — fix sugerido.
## Riesgos / suposiciones
## Verificaciones ejecutadas u omitidas
## Próximos pasos priorizados
Responde en español, conciso y estructurado.`,
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs,
    })),
    { concurrency },
  );

  await ctx.writeArtifact("reviews.json", reviews);
  await ctx.log("review agents completed", { count: reviews.length });

  const synthesis = await ctx.agent(
    `Sintetiza los reportes independientes en un unico informe de estado actual del repositorio.

Patrón de trabajo: synthesis-as-judge. Deduplica hallazgos, no hagas promedio de opiniones, conserva incertidumbre, descarta afirmaciones concretas sin evidencia salvo que estén marcadas como suposición.

Requisitos del informe:
- Estado general en 3-5 bullets.
- Cambios sin commitear / archivos nuevos relevantes.
- Salud de implementacion, docs/ejemplos y packaging.
- Verificaciones ejecutadas u omitidas.
- Riesgos o bloqueadores priorizados con severidad, confianza y evidencia.
- Proximas acciones recomendadas en orden, separando must/should/could.
- No inventes: conserva citas de archivo/linea cuando existan y marca lo especulativo.
- Menciona agentes fallidos o reportes vacíos si los hubiera.

Snapshot:
${snapshot}

Reportes:
${ctx.compact(reviews, 75_000)}`,
    { name: "sintesis-estado-actual", tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs },
  );

  await ctx.writeArtifact("estado-actual.md", synthesis.output);
  return synthesis.output;
};
