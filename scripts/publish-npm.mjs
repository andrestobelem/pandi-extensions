#!/usr/bin/env node
/**
 * Publish changed @pandi-coding-agent/* workspaces to npm.
 *
 * Per workspace (extensions/pandi*):
 *   - if <name>@<version> is NOT on npm            -> publish it
 *   - if it IS on npm and the local pack shasum
 *     matches the published dist.shasum            -> skip (unchanged)
 *   - if it IS on npm but content differs          -> report "needs version bump" (never overwrite)
 *
 * Note: shasums assume `npm pack` is byte-stable for identical content (true within one
 * npm version). If EVERY package suddenly reports BUMP?, suspect an npm/pacote upgrade,
 * not real content changes.
 *
 * Usage:
 *   node scripts/publish-npm.mjs            # dry run: show the plan only
 *   node scripts/publish-npm.mjs --publish  # actually run `npm publish --access public`
 *                                           # (with 2FA, npm prompts for OTP per package)
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Decide the action for one package: "publish" | "unchanged" | "bump". */
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
	if (otp) args.push(`--otp=${otp}`); // note: one TOTP code rarely survives >1 publish
	return withSafeNpmConfig(args);
}

function npm(cmdArgs, opts = {}) {
	return execFileSync("npm", withSafeNpmConfig(cmdArgs), { encoding: "utf8", ...opts }).trim();
}

/** Published dist.shasum for name@version, or null if that version is not on npm. */
function publishedShasum(name, version) {
	try {
		const out = npm(["view", `${name}@${version}`, "dist.shasum"], { stdio: ["ignore", "pipe", "pipe"] });
		return out === "" ? null : out; // some npm versions: missing version = exit 0, empty stdout
	} catch (err) {
		const msg = `${err.stderr ?? ""}${err.message ?? ""}`;
		if (msg.includes("E404")) return null; // version not published
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
				return null; // not a workspace (no/invalid package.json)
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

	// Exit 1 whenever there is unfinished work (needsBump), even after successful publishes.
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
