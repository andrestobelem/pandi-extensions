#!/usr/bin/env node
/**
 * setup-gondolin.mjs — instala la extensión upstream de aislamiento micro-VM Gondolin
 * en el directorio project-local de tools NO auto-discovered de este repo (.pi/tools/gondolin)
 * para que quede disponible bajo demanda vía `pi -e .pi/tools/gondolin`, sin bootear una VM
 * en cada sesión de pi.
 *
 * Por qué no vendorizarlo (commitearlo): Gondolin necesita una dependencia runtime real
 * (@earendil-works/gondolin) con binarios nativos específicos por plataforma, lo que
 * inflaría el lockfile de este repo y solo funciona en darwin-arm64 / linux-x64. En cambio,
 * copiamos el ejemplo que trae pi e instalamos sus deps con --ignore-scripts (la instalación
 * recomendada upstream, sin scripts; el runner krun es un binario prebuilt y ssh2 hace
 * fallback a JS puro sin el build nativo opcional de cpu-features). El target de instalación
 * .pi/tools/ está gitignored, así que las deps nativas pesadas quedan fuera del version control.
 *
 * Por qué .pi/tools/ y NO .pi/extensions/: un subdirectorio project-local .pi/extensions/
 * se auto-discoverea y se cargaría en cada sesión (un boot de micro-VM cada vez).
 * .pi/tools/ no es un path auto-discovered, así que Gondolin carga solo con un `pi -e` explícito.
 *
 * Uso:  node scripts/setup-gondolin.mjs   (o: npm run setup:gondolin)
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED = new Set(["darwin-arm64", "linux-x64"]);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(repoRoot, ".pi", "tools", "gondolin");

export function platformKey({ platform = process.platform, arch = process.arch } = {}) {
	return `${platform}-${arch}`;
}

export function isSupportedPlatform(key, supported = SUPPORTED) {
	return supported.has(key);
}

export function nodeVersionSupportsGondolin(version = process.versions.node) {
	const [major, minor] = version.split(".").map(Number);
	return major > 23 || (major === 23 && minor >= 6);
}

export function npmInstallEnv(env = process.env) {
	// Quitá del env heredado los npm_config_* para que un `npm run` padre no filtre config
	// (por ejemplo allow-scripts desde ~/.npmrc -> npm_config_allow_scripts) a esta
	// instalación anidada, que npm rechaza junto con --ignore-scripts (EALLOWSCRIPTS).
	return Object.fromEntries(Object.entries(env).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")));
}

function fail(message) {
	console.error(`\n✖ ${message}\n`);
	process.exit(1);
}

function main() {
	// 1. Guardia de arquitectura: solo se soportan plataformas con runner krun prebuilt.
	const hostPlatform = platformKey();
	if (!isSupportedPlatform(hostPlatform)) {
		fail(
			`Gondolin only ships prebuilt micro-VM runners for: ${[...SUPPORTED].join(", ")}.\n` +
				`  This host is "${hostPlatform}", which is unsupported and would crash at runtime.`,
		);
	}

	// 2. Guardia de engine de Node (@earendil-works/gondolin requiere Node >= 23.6.0).
	if (!nodeVersionSupportsGondolin(process.versions.node)) {
		fail(`Gondolin requires Node >= 23.6.0; this is ${process.versions.node}.`);
	}

	// 3. Ubicá el ejemplo de Gondolin que trae pi.
	let globalRoot;
	try {
		globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	} catch {
		fail("Could not run `npm root -g` to locate the global pi install.");
	}
	const example = path.join(globalRoot, "@earendil-works", "pi-coding-agent", "examples", "extensions", "gondolin");
	if (!existsSync(path.join(example, "index.ts"))) {
		fail(
			`Could not find pi's Gondolin example at:\n  ${example}\n` +
				"  If you installed pi via brew/npx/bun, copy <pi>/examples/extensions/gondolin manually\n" +
				`  into ${target} and run: npm install --ignore-scripts`,
		);
	}

	// Rechazá pisar una instalación existente (por ejemplo, una movida acá manualmente).
	if (existsSync(path.join(target, "index.ts"))) {
		console.log(`✓ Gondolin already installed at ${target} — nothing to do.`);
		process.exit(0);
	}

	// 4. Copiá el ejemplo (autocontenido) e instalá deps SIN lifecycle scripts.
	console.log(`→ Installing Gondolin into ${target}`);
	mkdirSync(target, { recursive: true });
	cpSync(example, target, { recursive: true });
	execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
		cwd: target,
		env: npmInstallEnv(),
		stdio: "inherit",
	});

	console.log(
		[
			"",
			"✓ Gondolin installed (project-local, not auto-loaded).",
			"",
			"Use it on demand from this repo:",
			"  pi -e .pi/tools/gondolin",
			"",
			"Verify inside the session:  /gondolin   •   !uname -a (Linux)   •   !ls -la /workspace",
			"",
			"Note: Gondolin isolates built-in tools and ! commands inside the VM, but does NOT",
			"isolate dynamic-workflow subagent process spawns. See docs/gondolin-isolation.md.",
		].join("\n"),
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
