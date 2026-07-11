import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("Prettier resolves Markdown prose wrapping at 120 characters", async () => {
	const config = await resolveConfig(path.join(REPO, "README.md"));
	assert.equal(config?.printWidth, 120);
	assert.equal(config?.proseWrap, "always");
});

test("Prettier keeps skill descriptions plain and wraps only when needed", async () => {
	const config = await resolveConfig(path.join(REPO, ".pi", "skills", "default", "SKILL.md"));
	const short = await format("---\nname: short\ndescription:\n  Texto corto.\n---\n", {
		...config,
		parser: "markdown",
	});
	assert.match(short, /^description: Texto corto\.$/mu);

	const longText = Array.from({ length: 30 }, (_, index) => `palabra${index}`).join(" ");
	const long = await format(`---\nname: long\ndescription: ${longText}\n---\n`, {
		...config,
		parser: "markdown",
	});
	assert.match(long, /^description:\n {2}\S/mu);
	for (const line of long.split("\n")) assert.ok(line.length <= 120);
});
