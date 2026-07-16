import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	assertPublishPlanMatchesWorkspace,
	buildPublishArgs,
	buildPublishPlanDocument,
	classify,
	classifyWorkspaces,
	isNpmMissingVersionError,
	loadPublishWorkspaces,
	parsePackShasum,
	parsePublishOptions,
	parsePublishPlanDocument,
	renderPublishPlanText,
	summarizePublishPlan,
	withSafeNpmConfig,
} from "../../publish-npm.mjs";

test("parsePackShasum: accepts npm pack array and npm 12 keyed-object output", () => {
	assert.equal(parsePackShasum('[{"shasum":"array-sha"}]'), "array-sha");
	assert.equal(parsePackShasum('{"@pandi-coding-agent/pandi":{"shasum":"keyed-object-sha"}}'), "keyed-object-sha");
	assert.throws(() => parsePackShasum('{"@pandi-coding-agent/pandi":{}}'), /unparseable `npm pack --json` output/);
});

test("classify: version not on npm -> publish", () => {
	assert.equal(classify(null, "abc123"), "publish");
});

test("classify: remote shasum matches local -> unchanged", () => {
	assert.equal(classify("abc123", "abc123"), "unchanged");
});

test("classify: remote shasum differs from local -> bump", () => {
	assert.equal(classify("abc123", "def456"), "bump");
});

test("publish plan rejects a stale local package", () => {
	assert.throws(
		() =>
			assertPublishPlanMatchesWorkspace(
				{ name: "@scope/package", version: "1.0.0", localShasum: "planned" },
				{ pkg: { name: "@scope/package", version: "1.0.0" }, localShasum: "current" },
			),
		/stale publish plan/,
	);
});

test("publish plan accepts its matching local package", () => {
	assert.doesNotThrow(() =>
		assertPublishPlanMatchesWorkspace(
			{ name: "@scope/package", version: "1.0.0", localShasum: "same" },
			{ pkg: { name: "@scope/package", version: "1.0.0" }, localShasum: "same" },
		),
	);
});

test("withSafeNpmConfig: registry commands ignore local min-release-age", () => {
	assert.deepEqual(withSafeNpmConfig(["view", "pkg", "version"]), ["view", "pkg", "version", "--min-release-age=0"]);
});

test("isNpmMissingVersionError: recognizes npm v24 missing-version output", () => {
	assert.equal(
		isNpmMissingVersionError({
			stderr: Buffer.from("npm error code E404\nnpm error 404 No match found for version"),
		}),
		true,
	);
	assert.equal(isNpmMissingVersionError({ message: "network timeout" }), false);
});

test("buildPublishArgs: public latest publish with safe npm config", () => {
	assert.deepEqual(buildPublishArgs({}), ["publish", "--access", "public", "--tag", "latest", "--min-release-age=0"]);
});

test("buildPublishArgs: optional provenance and otp", () => {
	assert.deepEqual(buildPublishArgs({ provenance: true, otp: "123456", tag: "next" }), [
		"publish",
		"--access",
		"public",
		"--tag",
		"next",
		"--provenance",
		"--otp=123456",
		"--min-release-age=0",
	]);
});

test("parsePublishOptions: publish flags and tag spellings", () => {
	assert.deepEqual(parsePublishOptions(["--publish", "--provenance", "--otp=123456", "--tag", "beta"]), {
		doPublish: true,
		provenance: true,
		otp: "123456",
		tag: "beta",
		concurrency: 8,
		publishConcurrency: 1,
		planFile: undefined,
		fromPlan: undefined,
		jsonOnly: false,
	});
	assert.deepEqual(parsePublishOptions(["--tag=next"]), {
		doPublish: false,
		provenance: false,
		otp: undefined,
		tag: "next",
		concurrency: 8,
		publishConcurrency: 1,
		planFile: undefined,
		fromPlan: undefined,
		jsonOnly: false,
	});
});

test("parsePublishOptions: plan cache and concurrency flags", () => {
	assert.deepEqual(parsePublishOptions(["--plan-file=plan.json", "--from-plan=other.json", "--concurrency", "4"]), {
		doPublish: false,
		provenance: false,
		otp: undefined,
		tag: undefined,
		concurrency: 4,
		publishConcurrency: 1,
		planFile: "plan.json",
		fromPlan: "other.json",
		jsonOnly: false,
	});
});

test("publish plan document round-trips and renders legacy text", () => {
	const document = buildPublishPlanDocument([
		{ dir: "/a", relDir: "extensions/pandi-a", name: "@pandi/a", version: "1.0.0", action: "publish" },
		{ dir: "/b", relDir: "extensions/pandi-b", name: "@pandi/b", version: "1.0.0", action: "bump" },
	]);
	assert.deepEqual(summarizePublishPlan(document.packages), { total: 2, publish: 1, unchanged: 0, bump: 1 });
	const roundTrip = parsePublishPlanDocument(JSON.stringify(document));
	assert.deepEqual(roundTrip.summary, document.summary);
	assert.match(renderPublishPlanText(document), /PUBLISH\s+@pandi\/a@1\.0\.0/);
	assert.match(renderPublishPlanText(document), /BUMP\?\s+@pandi\/b@1\.0\.0/);
});

test("classifyWorkspaces: classifies with injected npm shims", async () => {
	const workspaces = [
		{ dir: "/a", relDir: "extensions/pandi-a", pkg: { name: "@pandi/a", version: "1.0.0" } },
		{ dir: "/b", relDir: "extensions/pandi-b", pkg: { name: "@pandi/b", version: "2.0.0" } },
	];
	const npm = async (args) => {
		if (args[0] === "view") return args[1] === "@pandi/a@1.0.0" ? "" : "remote-sha";
		if (args[0] === "pack") return args.includes("--json") ? '[{"shasum":"local-a"}]' : "";
		throw new Error(`unexpected npm call: ${args.join(" ")}`);
	};
	const packages = await classifyWorkspaces(workspaces, {
		concurrency: 2,
		npm: async (args, opts) => {
			if (args[0] === "pack") {
				const dir = opts.cwd;
				return dir === "/a" ? '[{"shasum":"local-a"}]' : '[{"shasum":"other-local"}]';
			}
			return npm(args);
		},
	});
	assert.deepEqual(
		packages.map(({ name, action }) => ({ name, action })),
		[
			{ name: "@pandi/a", action: "publish" },
			{ name: "@pandi/b", action: "bump" },
		],
	);
});

function writePackage(root, dir, pkg) {
	const file = path.join(root, "extensions", dir, "package.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(pkg)}\n`);
}

test("loadPublishWorkspaces: keeps public pandi packages and skips private/invalid dirs", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-workspaces-"));
	try {
		writePackage(root, "pandi-alpha", { name: "@pandi/alpha", version: "1.0.0" });
		writePackage(root, "pandi-private", { name: "@pandi/private", private: true });
		writePackage(root, "other", { name: "other" });
		fs.mkdirSync(path.join(root, "extensions", "pandi-invalid"), { recursive: true });
		fs.writeFileSync(path.join(root, "extensions", "pandi-invalid", "package.json"), "not json");

		assert.deepEqual(
			loadPublishWorkspaces(root).map(({ pkg }) => pkg.name),
			["@pandi/alpha"],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
