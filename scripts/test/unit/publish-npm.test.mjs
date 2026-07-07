import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	buildPublishArgs,
	classify,
	isNpmMissingVersionError,
	loadPublishWorkspaces,
	parsePublishOptions,
	withSafeNpmConfig,
} from "../../publish-npm.mjs";

test("classify: version not on npm -> publish", () => {
	assert.equal(classify(null, "abc123"), "publish");
});

test("classify: remote shasum matches local -> unchanged", () => {
	assert.equal(classify("abc123", "abc123"), "unchanged");
});

test("classify: remote shasum differs from local -> bump", () => {
	assert.equal(classify("abc123", "def456"), "bump");
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
	});
	assert.deepEqual(parsePublishOptions(["--tag=next"]), {
		doPublish: false,
		provenance: false,
		otp: undefined,
		tag: "next",
	});
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
