module.exports = async function workflow(ctx, input) {
  const agentTimeoutMs = input?.agentTimeoutMs ?? ctx.limits.agentTimeoutMs;
  await ctx.log("review-dynamic-workflows:start", { input });

  const allFiles = await ctx.listFiles(".", { maxFiles: 2000 });
  const relevantFiles = allFiles
    .filter((file) =>
      file === "extensions/dynamic-workflows.ts" ||
      file === "skills/dynamic-workflows/SKILL.md" ||
      file === "README.md" ||
      file === "package.json" ||
      file === ".pi/workflows/review-dynamic-workflows.js" ||
      /^examples\/workflows\/.*\.js$/.test(file),
    )
    .sort();

  await ctx.writeArtifact("target-files.json", relevantFiles);
  await ctx.log("target files selected", { count: relevantFiles.length, relevantFiles });

  const groups = [
    {
      name: "runtime-security",
      files: ["extensions/dynamic-workflows.ts"],
      focus: "runtime isolation, path traversal/symlink safety, abort/timeouts, resource limits, subagent spawning, artifact handling, worker VM risks",
    },
    {
      name: "workflow-api-correctness",
      files: ["extensions/dynamic-workflows.ts", ".pi/workflows/review-dynamic-workflows.js"],
      focus: "ctx API behavior, concurrency/maxAgents enforcement, error handling, graph/view/run actions, and edge cases in this review workflow",
    },
    {
      name: "examples-and-docs",
      files: relevantFiles.filter((file) => file === "README.md" || /^examples\/workflows\//.test(file)),
      focus: "example workflows and README accuracy, safe defaults, copy-paste reliability, docs/implementation mismatches",
    },
    {
      name: "skill-and-package",
      files: ["skills/dynamic-workflows/SKILL.md", "package.json", "README.md"],
      focus: "skill frontmatter/activation, package pi manifest, install instructions, resource conflicts/collisions, publishing readiness",
    },
  ];

  const reviewerPrompt = (group) => `You are auditing the Pi dynamic workflows package.

Pattern: independent adversarial review. Do not assume other reviewers will cover anything. Do not edit files.

Files to inspect:
${group.files.map((file) => `- ${file}`).join("\n")}

Focus: ${group.focus}

Evidence rules:
- Use only repository evidence; cite file paths and line numbers for every concrete finding.
- Prefer real bugs/security issues/docs mismatches over style.
- If a concern is speculative, label it SPECULATIVE and lower confidence.
- If no credible finding exists, say NO_FINDINGS for that area.

Output contract:
## Verdict
## Findings
For each: Severity Critical/High/Medium/Low, Confidence High/Medium/Low, Evidence, Impact, Concrete fix.
## Verification gaps
## Non-findings / things checked
Keep the report concise but actionable.`;

  const reviews = await ctx.agents(
    groups.map((group) => ({
      name: group.name,
      prompt: reviewerPrompt(group),
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: agentTimeoutMs,
    })),
    { concurrency: Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency) },
  );

  await ctx.writeArtifact("reviews.json", reviews);
  await ctx.log("review agents completed", { count: reviews.length });

  const synthesis = await ctx.agent(
    `Synthesize these independent audit reports into one prioritized review of the dynamic workflow implementation.

Pattern: synthesis-as-judge / evaluator. Do not average reviewer opinions. Deduplicate findings, discard uncited concrete claims unless marked speculative, and preserve disagreement when relevant.

Requirements:
- Executive verdict: safe to use now? under what constraints?
- Prioritized table: severity | confidence | finding | evidence | fix.
- Must-fix before release vs should-fix later.
- Verification gaps and exact commands/manual checks.
- Accepted risks.

Reports:
${ctx.compact(reviews, 70000)}`,
    { name: "synthesis", tools: ["read", "grep", "find", "ls"], timeoutMs: agentTimeoutMs },
  );

  await ctx.writeArtifact("summary.md", synthesis.output);
  return synthesis.output;
};
