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
 *   node scripts/publish-npm.mjs            # dry run: muestra solo el plan
 *   node scripts/publish-npm.mjs --publish  # ejecuta de verdad `npm publish --access public`
 *                                           # (con 2FA, npm pide OTP por package)
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

function npm(cmdArgs, opts = {}) {
	return execFileSync("npm", withSafeNpmConfig(cmdArgs), { encoding: "utf8", ...opts }).trim();
}

/** dist.shasum publicado para name@version, o null si esa versión no está en npm. */
function publishedShasum(name, version) {
	try {
		const out = npm(["view", `${name}@${version}`, "dist.shasum"], { stdio: ["ignore", "pipe", "pipe"] });
		return out === "" ? null : out; // en algunas versiones de npm: versión faltante = exit 0, stdout vacío
	} catch (err) {
		const msg = `${err.stderr ?? ""}${err.message ?? ""}`;
		if (msg.includes("E404")) return null; // versión no publicada
		throw new Error(`npm view failed for ${name}@${version} (not a 404 — refusing to guess):\n${msg}`);
	}
}

function localShasum(dir) {
	const out = npm(["pack", "--dry-run", "--json"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
	try {
		return JSON.parse(out)[0].shasum;
	} catch {
		throw new Error(`unparseable \`npm pack --json\` output in ${dir}`);
	}
}

function main() {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const args = process.argv.slice(2);
	const doPublish = args.includes("--publish");
	const provenance = args.includes("--provenance");
	const otp = args.find((a) => a.startsWith("--otp="))?.slice(6);
	const tagIndex = args.indexOf("--tag");
	const tag = args.find((a) => a.startsWith("--tag="))?.slice(6) || (tagIndex >= 0 ? args[tagIndex + 1] : undefined);

	const extDir = join(root, "extensions");
	const workspaces = readdirSync(extDir)
		.filter((d) => d === "pandi" || d.startsWith("pandi-"))
		.map((d) => join(extDir, d))
		.map((dir) => {
			try {
				return { dir, pkg: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) };
			} catch {
				return null; // no es un workspace (package.json faltante o inválido)
			}
		})
		.filter((w) => w !== null && !w.pkg.private);

	const toPublish = [];
	const needsBump = [];
	let unchanged = 0;

	for (const { dir, pkg } of workspaces) {
		const action = classify(publishedShasum(pkg.name, pkg.version), localShasum(dir));
		if (action === "publish") {
			toPublish.push({ dir, name: pkg.name, version: pkg.version });
			console.log(`PUBLISH  ${pkg.name}@${pkg.version} (version not on npm)`);
		} else if (action === "unchanged") {
			unchanged++;
		} else {
			needsBump.push(pkg.name);
			console.log(`BUMP?    ${pkg.name}@${pkg.version} (published but content differs — bump the version first)`);
		}
	}

	console.log(
		`\n${workspaces.length} workspaces: ${toPublish.length} to publish, ${unchanged} unchanged, ${needsBump.length} need a version bump.`,
	);

	// Sale con 1 siempre que quede trabajo pendiente (needsBump), incluso después de publishes exitosos.
	if (needsBump.length > 0) process.exitCode = 1;

	if (!doPublish) {
		if (toPublish.length > 0) console.log("Dry run. Re-run with --publish to publish.");
		return;
	}

	const failed = [];
	for (const { dir, name, version } of toPublish) {
		console.log(`\n→ npm publish ${name}@${version}`);
		const publishArgs = buildPublishArgs({ otp, provenance, tag: tag || "latest" });
		try {
			execFileSync("npm", publishArgs, { cwd: dir, stdio: "inherit" });
		} catch {
			failed.push(`${name}@${version}`);
		}
	}

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
	main();
}
