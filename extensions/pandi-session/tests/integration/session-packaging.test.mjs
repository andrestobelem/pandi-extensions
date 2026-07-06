#!/usr/bin/env node
/** Packaging contract for the standalone pandi-session extension. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXT_DIR = path.join(REPO_ROOT, "extensions", "pandi-session");
const { check, counts } = createChecker();

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

const pkg = readJson(path.join(EXT_DIR, "package.json"));
check(
	"package name uses the scoped pandi-session identity",
	pkg.name === "@pandi-coding-agent/pandi-session",
	pkg.name,
);
check("package publishes depth-one runtime TS files", pkg.files?.includes("*.ts"), JSON.stringify(pkg.files));
check("package publishes its README", pkg.files?.includes("README.md"), JSON.stringify(pkg.files));
check(
	"package registers index.ts as the Pi extension entrypoint",
	pkg.pi?.extensions?.includes("./index.ts"),
	JSON.stringify(pkg.pi),
);
check(
	"package pins the current Pi peer floor",
	pkg.peerDependencies?.["@earendil-works/pi-coding-agent"] === "^0.80.3" &&
		pkg.peerDependencies?.["@earendil-works/pi-tui"] === "^0.80.3",
	JSON.stringify(pkg.peerDependencies),
);

console.log(`\n${counts.passed} checks passed`);
if (counts.failed) {
	console.error("Failures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
