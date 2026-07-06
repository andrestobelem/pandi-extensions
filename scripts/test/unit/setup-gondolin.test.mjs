import assert from "node:assert/strict";
import { test } from "node:test";
import { isSupportedPlatform, nodeVersionSupportsGondolin, npmInstallEnv, platformKey } from "../../setup-gondolin.mjs";

test("platform helpers preserve the supported Gondolin host allowlist", () => {
	assert.equal(platformKey({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
	assert.equal(isSupportedPlatform("darwin-arm64"), true);
	assert.equal(isSupportedPlatform("linux-x64"), true);
	assert.equal(isSupportedPlatform("linux-arm64"), false);
});

test("nodeVersionSupportsGondolin matches the Node >= 23.6.0 guard", () => {
	assert.equal(nodeVersionSupportsGondolin("22.19.0"), false);
	assert.equal(nodeVersionSupportsGondolin("23.5.9"), false);
	assert.equal(nodeVersionSupportsGondolin("23.6.0"), true);
	assert.equal(nodeVersionSupportsGondolin("24.0.0"), true);
});

test("npmInstallEnv strips npm_config_* keys case-insensitively", () => {
	assert.deepEqual(npmInstallEnv({ PATH: "/bin", npm_config_allow_scripts: "true", NPM_CONFIG_CACHE: "x" }), {
		PATH: "/bin",
	});
});
