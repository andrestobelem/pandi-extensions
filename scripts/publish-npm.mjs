#!/usr/bin/env node
/**
 * Publish changed @pandi-coding-agent/* workspaces to npm.
 *
 * Per workspace (extensions/pi-*):
 *   - if <name>@<version> is NOT on npm            -> publish it
 *   - if it IS on npm and the local pack shasum
 *     matches the published dist.shasum            -> skip (unchanged)
 *   - if it IS on npm but content differs          -> report "needs version bump" (never overwrite)
 *
 * Usage:
 *   node scripts/publish-npm.mjs            # dry run: show the plan only
 *   node scripts/publish-npm.mjs --publish  # actually run `npm publish --access public`
 *   node scripts/publish-npm.mjs --otp=123456 --publish
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const doPublish = args.includes("--publish");
const otp = args.find((a) => a.startsWith("--otp="))?.slice(6);

function npm(cmdArgs, opts = {}) {
	return execFileSync("npm", cmdArgs, { encoding: "utf8", ...opts }).trim();
}

function publishedShasum(name, version) {
	try {
		return npm(["view", `${name}@${version}`, "dist.shasum"], { stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return null; // version not published
	}
}

function localShasum(dir) {
	const out = npm(["pack", "--dry-run", "--json"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
	return JSON.parse(out)[0].shasum;
}

const extDir = join(root, "extensions");
const workspaces = readdirSync(extDir)
	.filter((d) => d.startsWith("pi-"))
	.map((d) => join(extDir, d))
	.filter((dir) => {
		try {
			readFileSync(join(dir, "package.json"));
			return true;
		} catch {
			return false;
		}
	});

const toPublish = [];
const needsBump = [];
let unchanged = 0;

for (const dir of workspaces) {
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	if (pkg.private) continue;
	const remote = publishedShasum(pkg.name, pkg.version);
	if (remote === null) {
		toPublish.push({ dir, name: pkg.name, version: pkg.version });
		console.log(`PUBLISH  ${pkg.name}@${pkg.version} (version not on npm)`);
	} else if (remote === localShasum(dir)) {
		unchanged++;
	} else {
		needsBump.push(pkg.name);
		console.log(`BUMP?    ${pkg.name}@${pkg.version} (published but content differs — bump the version first)`);
	}
}

console.log(
	`\n${workspaces.length} workspaces: ${toPublish.length} to publish, ${unchanged} unchanged, ${needsBump.length} need a version bump.`,
);

if (needsBump.length > 0) process.exitCode = 1;

if (!doPublish) {
	if (toPublish.length > 0) console.log("Dry run. Re-run with --publish to publish.");
	process.exit();
}

for (const { dir, name, version } of toPublish) {
	console.log(`\n→ npm publish ${name}@${version}`);
	const publishArgs = ["publish", "--access", "public"];
	if (otp) publishArgs.push(`--otp=${otp}`);
	execFileSync("npm", publishArgs, { cwd: dir, stdio: "inherit" });
}

if (toPublish.length > 0) {
	console.log("\nDone. Note: fresh versions may take a while to be visible (npm propagation / min-release-age).");
}
