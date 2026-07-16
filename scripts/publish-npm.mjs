#!/usr/bin/env node
/**
 * Publica en npm los workspaces @pandi-coding-agent/* que cambiaron.
 *
 * Por workspace (extensions/pandi*):
 *   - si <name>@<version> NO está en npm          -> publícalo
 *   - si SÍ está en npm y el shasum del pack local
 *     coincide con el dist.shasum publicado       -> sáltalo (sin cambios)
 *   - si SÍ está en npm pero el contenido difiere -> reporta "needs version bump" (nunca sobreescribe)
 *
 * NOTE: los shasums asumen que `npm pack` es byte-stable para contenido idéntico (cierto dentro de una
 * versión de npm). Si TODOS los packages de golpe reportan BUMP?, sospechá de un upgrade de npm/pacote,
 * no de cambios reales de contenido.
 *
 * Uso:
 *   node scripts/publish-npm.mjs                              # dry run
 *   node scripts/publish-npm.mjs --plan-file .release-plan.json
 *   node scripts/publish-npm.mjs --from-plan .release-plan.json --publish
 *   node scripts/publish-npm.mjs --publish                    # publica (con 2FA, npm pide OTP por package)
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parsePositiveInt, valueAfter } from "./lib/cli-args.mjs";
import { mapPool } from "./lib/pool.mjs";
import { loadPublicWorkspaces } from "./lib/release-workspaces.mjs";

const execFileAsync = promisify(execFile);
export const PUBLISH_PLAN_VERSION = 1;

/** Decide la acción para un package: "publish" | "unchanged" | "bump". */
export function classify(remoteShasum, localShasum) {
	if (remoteShasum === null) return "publish";
	return remoteShasum === localShasum ? "unchanged" : "bump";
}

export function withSafeNpmConfig(cmdArgs) {
	return cmdArgs.includes("--min-release-age=0") ? cmdArgs : [...cmdArgs, "--min-release-age=0"];
}

export function buildPublishArgs({ otp, provenance = false, tag = "latest" } = {}) {
	const args = ["publish", "--access", "public", "--tag", tag];
	if (provenance) args.push("--provenance");
	if (otp) args.push(`--otp=${otp}`); // nota: un código TOTP rara vez sobrevive a más de 1 publish
	return withSafeNpmConfig(args);
}

export function parsePublishOptions(args) {
	const tagIndex = args.indexOf("--tag");
	return {
		doPublish: args.includes("--publish"),
		provenance: args.includes("--provenance"),
		otp: args.find((a) => a.startsWith("--otp="))?.slice(6),
		tag: args.find((a) => a.startsWith("--tag="))?.slice(6) || (tagIndex >= 0 ? args[tagIndex + 1] : undefined),
		concurrency: parsePositiveInt(valueAfter(args, "--concurrency"), 8),
		publishConcurrency: parsePositiveInt(valueAfter(args, "--publish-concurrency"), 1),
		planFile: valueAfter(args, "--plan-file"),
		fromPlan: valueAfter(args, "--from-plan"),
		jsonOnly: args.includes("--json"),
	};
}

/** @deprecated Usá loadPublicWorkspaces desde release-workspaces.mjs */
export function loadPublishWorkspaces(root) {
	return loadPublicWorkspaces(root).map(({ dir, pkg }) => ({ dir, pkg }));
}

async function npmAsync(cmdArgs, opts = {}) {
	const { stdout } = await execFileAsync("npm", withSafeNpmConfig(cmdArgs), {
		encoding: "utf8",
		...opts,
		env: { ...process.env, ...opts.env, npm_config_loglevel: "error" },
	});
	return stdout.trim();
}

function npmErrorText(err) {
	const e = err ?? {};
	return `${e.stdout?.toString?.() ?? ""}${e.stderr?.toString?.() ?? ""}${e.message ?? ""}`;
}

export function isNpmMissingVersionError(err) {
	const msg = npmErrorText(err);
	return msg.includes("E404") || msg.includes("No match found for version");
}

/** dist.shasum publicado para name@version, o null si esa versión no está en npm. */
export async function publishedShasum(name, version, { npm = npmAsync } = {}) {
	try {
		const out = await npm(["view", `${name}@${version}`, "dist.shasum"], { stdio: ["ignore", "pipe", "pipe"] });
		return out === "" ? null : out;
	} catch (err) {
		const msg = npmErrorText(err);
		if (isNpmMissingVersionError(err)) return null;
		throw new Error(`npm view failed for ${name}@${version} (not a 404 — refusing to guess):\n${msg}`);
	}
}

export function parsePackShasum(output) {
	let parsed;
	try {
		parsed = JSON.parse(output);
	} catch {
		throw new Error("unparseable `npm pack --json` output");
	}

	const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
	const shasum = entries.length === 1 ? entries[0]?.shasum : undefined;
	if (typeof shasum !== "string" || shasum.length === 0) {
		throw new Error("unparseable `npm pack --json` output");
	}
	return shasum;
}

export async function localShasum(dir, { npm = npmAsync } = {}) {
	const out = await npm(["pack", "--dry-run", "--json"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
	try {
		return parsePackShasum(out);
	} catch {
		throw new Error(`unparseable \`npm pack --json\` output in ${dir}`);
	}
}

export function summarizePublishPlan(packages) {
	const summary = { total: packages.length, publish: 0, unchanged: 0, bump: 0 };
	for (const entry of packages) summary[entry.action]++;
	return summary;
}

export function buildPublishPlanDocument(packages) {
	return {
		version: PUBLISH_PLAN_VERSION,
		generatedAt: new Date().toISOString(),
		summary: summarizePublishPlan(packages),
		packages,
	};
}

export function parsePublishPlanDocument(raw) {
	const plan = typeof raw === "string" ? JSON.parse(raw) : raw;
	if (!plan || plan.version !== PUBLISH_PLAN_VERSION || !Array.isArray(plan.packages)) {
		throw new Error("invalid publish plan document");
	}
	return plan;
}

export function renderPublishPlanLine(entry) {
	if (entry.action === "publish") {
		return `PUBLISH  ${entry.name}@${entry.version} (version not on npm)`;
	}
	if (entry.action === "bump") {
		return `BUMP?    ${entry.name}@${entry.version} (published but content differs — bump the version first)`;
	}
	return `UNCHANGED ${entry.name}@${entry.version}`;
}

export function renderPublishPlanText(plan) {
	const lines = plan.packages.map(renderPublishPlanLine);
	const { total, publish, unchanged, bump } = plan.summary;
	lines.push(`\n${total} workspaces: ${publish} to publish, ${unchanged} unchanged, ${bump} need a version bump.`);
	return `${lines.join("\n")}\n`;
}

export async function classifyWorkspaces(workspaces, { concurrency = 8, npm = npmAsync } = {}) {
	const remoteShasums = await mapPool(workspaces, concurrency, async ({ pkg }) =>
		publishedShasum(pkg.name, pkg.version, { npm }),
	);
	const localShasums = await mapPool(workspaces, concurrency, async ({ dir }) => localShasum(dir, { npm }));

	return workspaces.map(({ dir, relDir, pkg }, index) => ({
		dir,
		relDir,
		name: pkg.name,
		version: pkg.version,
		localShasum: localShasums[index],
		action: classify(remoteShasums[index], localShasums[index]),
	}));
}

/** Falla cerrado si el checkout ya no coincide con el plan que se quiere publicar. */
export function assertPublishPlanMatchesWorkspace(planned, current) {
	if (
		planned.name !== current.pkg.name ||
		planned.version !== current.pkg.version ||
		planned.localShasum !== current.localShasum
	) {
		throw new Error(
			`stale publish plan for ${planned.name}@${planned.version} — regenerate the plan from the current checkout`,
		);
	}
}

export async function assertPublishPlanMatchesLocalWorkspaces(
	plan,
	workspaces,
	{ concurrency = 8, npm = npmAsync } = {},
) {
	if (plan.packages.length !== workspaces.length) {
		throw new Error(
			"stale publish plan — workspace inventory changed; regenerate the plan from the current checkout",
		);
	}
	const localShasums = await mapPool(workspaces, concurrency, async ({ dir }) => localShasum(dir, { npm }));
	for (const [index, workspace] of workspaces.entries()) {
		assertPublishPlanMatchesWorkspace(plan.packages[index], { pkg: workspace.pkg, localShasum: localShasums[index] });
	}
}

export async function buildPublishPlan(root, options = {}) {
	const workspaces = loadPublicWorkspaces(root);
	const packages = await classifyWorkspaces(workspaces, options);
	return buildPublishPlanDocument(packages);
}

function readPublishPlan(fromPlan) {
	return parsePublishPlanDocument(readFileSync(fromPlan, "utf8"));
}

function writePublishPlan(planFile, plan) {
	writeFileSync(planFile, `${JSON.stringify(plan, null, "\t")}\n`);
}

async function publishPackages(toPublish, { provenance, otp, tag, publishConcurrency }) {
	const failed = [];
	await mapPool(toPublish, publishConcurrency, async ({ dir, name, version }) => {
		console.log(`\n→ npm publish ${name}@${version}`);
		const publishArgs = buildPublishArgs({ otp, provenance, tag: tag || "latest" });
		try {
			execFileSync("npm", publishArgs, { cwd: dir, stdio: "inherit" });
		} catch {
			failed.push(`${name}@${version}`);
		}
	});
	return failed;
}

async function main() {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const opts = parsePublishOptions(process.argv.slice(2));
	if (opts.planFile && opts.fromPlan) {
		throw new Error("use either --plan-file or --from-plan, not both");
	}

	const plan = opts.fromPlan
		? readPublishPlan(opts.fromPlan)
		: await buildPublishPlan(root, { concurrency: opts.concurrency });

	if (opts.fromPlan) {
		await assertPublishPlanMatchesLocalWorkspaces(plan, loadPublicWorkspaces(root), {
			concurrency: opts.concurrency,
		});
	}
	if (opts.planFile && !opts.fromPlan) writePublishPlan(opts.planFile, plan);

	const text = renderPublishPlanText(plan);
	if (opts.jsonOnly) {
		process.stdout.write(`${JSON.stringify(plan, null, "\t")}\n`);
	} else {
		process.stdout.write(text);
	}

	const needsBump = plan.packages.filter((entry) => entry.action === "bump");
	const toPublish = plan.packages.filter((entry) => entry.action === "publish");

	if (needsBump.length > 0) process.exitCode = 1;

	if (!opts.doPublish) {
		if (toPublish.length > 0 && !opts.jsonOnly) console.log("Dry run. Re-run with --publish to publish.");
		return;
	}

	const failed = await publishPackages(toPublish, opts);
	if (failed.length > 0) {
		console.error(
			`\n${failed.length} publish(es) FAILED (OTP expiry?): ${failed.join(", ")} — re-run; already-published packages are skipped.`,
		);
		process.exitCode = 1;
	} else if (toPublish.length > 0) {
		console.log("\nDone. Note: fresh versions may take a while to be visible (npm propagation / min-release-age).");
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
