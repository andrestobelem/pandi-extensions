#!/usr/bin/env node
/** Contrato de empaquetado para la extensión independiente pandi-session. */
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
	"el nombre del paquete usa la identidad con scope de pandi-session",
	pkg.name === "@pandi-coding-agent/pandi-session",
	pkg.name,
);
check(
	"el paquete publica archivos TS de runtime a profundidad uno",
	pkg.files?.includes("*.ts"),
	JSON.stringify(pkg.files),
);
check("el paquete publica su README", pkg.files?.includes("README.md"), JSON.stringify(pkg.files));
check(
	"el paquete registra index.ts como el punto de entrada de la extensión Pi",
	pkg.pi?.extensions?.includes("./index.ts"),
	JSON.stringify(pkg.pi),
);
check(
	"el paquete fija el piso actual de peers de Pi",
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
