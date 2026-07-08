/**
 * Política pura del gate destructivo de pandi-loop. index.ts decide cuándo aplicarla;
 * este módulo solo clasifica comandos bash y rutas write/edit.
 */

import * as path from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * Operaciones destructivas que requieren confirmación en turnos autopilot. Busca
 * atrapar acciones irreversibles o de alto radio sin interferir con turnos humanos
 * ni con trabajo normal del loop (lecturas, greps, ediciones normales).
 *
 * Cubre:
 *  - comandos bash que matchean:
 *      rm recursivo: -r / -R / -rf / -fr / --recursive. rm de archivo único no se bloquea.
 *      find ... -delete y find ... -exec rm (incluye rm con ruta como /bin/rm)
 *      truncate / shred (destrucción in-place de archivos existentes)
 *      redirecciones de shell (>, >>, la forma clobber `>|`/`>>|`, y AMBAS escrituras
 *        combinadas `&>`/`&>>` y `>&`/`N>&`) y tee (cada target posicional, no solo el
 *        primero) que escriben FUERA del cwd del proyecto, incluidos targets que
 *        escapan con ~ inicial (home), $VAR/${VAR} sin expandir, sustitución de comando
 *        ($(...) / `...`), ruta escapada con backslash (`\/etc/...`) o target relativo
 *        alcanzado tras `cd`/`pushd` a un dir fuera del proyecto
 *      git push --force / -f / --force-with-lease / +refspec, y destructores remotos
 *        sin force --delete / --mirror / --prune y el refspec de borrado `origin :branch`
 *      git reset --hard / git checkout -f|--force (pérdida del working-tree)
 *      git clean -fd / -xfd
 *      git filter-branch (reescritura de historia) y git stash clear / stash drop (pérdida de stash)
 *      DROP TABLE/DATABASE/SCHEMA/TABLESPACE/OWNED (SQL drops)
 *      TRUNCATE TABLE
 *      kubectl apply|delete / terraform apply|destroy / helm upgrade|install|uninstall|
 *        delete|rollback
 *      dd  (escrituras crudas a disco)
 *      mkfs y sus alias (mke2fs / mkdosfs / mkntfs / mkswap / newfs) - formateo de device
 *
 *  Las continuaciones de línea con backslash se colapsan a espacio antes del match, así
 *  dividir un comando en líneas (`rm \\<newline> -rf d`) no oculta sus flags a los patrones.
 *
 * No hay patrón genérico para "deploy": es una palabra común y produciría falsos
 * positivos (`cat deploy.md`, `npm run deploy:dry-run`). Las herramientas reales de
 * deploy ya quedan cubiertas por kubectl/terraform/helm.
 *
 *  - write/edit apuntando a una ruta FUERA del cwd confiable del proyecto (ruta absoluta
 *    que no empieza con ctx.cwd, o cualquier ruta que escape vía "..").
 *
 * Sesgo: ante duda, permitir. Este gate es defense-in-depth, no un sandbox: regexes no
 * cubren intérpretes genéricos, alias, variables ni indirección runtime sin demasiados
 * falsos positivos.
 */
export const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
	// rm recursivo; rm de un archivo suelto queda permitido.
	/\brm\b(?=[^\n]*(\s-[a-z]*[rR]|\s--recursive\b))/i,
	// Borrado vía find: `find … -delete` y `find … -exec rm …` (permite rm con ruta
	// como `-exec /bin/rm` o `-exec /usr/bin/rm`, que `rm\b` suelto no vería).
	/\bfind\b[^\n]*\s-delete\b/i,
	/\bfind\b[^\n]*-exec\s+(?:\S*\/)?rm\b/i,
	// Destrucción in-place de datos de archivos existentes (coreutils truncate, shred).
	/\btruncate\b/i,
	/\bshred\b/i,
	/\bgit\b[^\n]*\bpush\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i,
	// Push forzado vía refspec `+` (ej. `git push origin +master`): un `+` inicial en el
	// refspec fuerza el update del ref remoto sin flag --force/-f, así que el patrón
	// por flag de arriba no lo ve. `\s\+\S` ancla en un token `+<ref>` tras whitespace.
	/\bgit\b[^\n]*\bpush\b[^\n]*\s\+[^\s]/i,
	// Pushes remotos destructivos sin flag force: `--delete`/`--mirror`/`--prune`
	// (borran o reescriben refs remotos) y el refspec con origen vacío `origin :branch`
	// (borra la rama remota). El colon tras whitespace `\s:\S` evita matchear colons de
	// `host:repo`/`main:refs/...` en URLs de push y mappings de refs normales.
	/\bgit\b[^\n]*\bpush\b[^\n]*(--delete\b|--mirror\b|--prune\b)/i,
	/\bgit\b[^\n]*\bpush\b[^\n]*\s:\S/i,
	/\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i,
	/\bgit\b[^\n]*\bclean\b[^\n]*\s-[a-z]*f/i,
	// git checkout -f / --force descarta cambios del working-tree sin commit (sin reflog
	// para ellos): misma clase de pérdida irreversible de working-tree que reset --hard.
	/\bgit\b[^\n]*\bcheckout\b[^\n]*\s(?:-f\b|--force\b)/i,
	// Reescritura de historia git (filter-branch) y destrucción de stash (stash clear/drop)
	// son irreversibles: misma familia git destructiva que reset --hard / clean -fd arriba.
	/\bgit\b[^\n]*\bfilter-branch\b/i,
	/\bgit\b[^\n]*\bstash\b[^\n]*\b(clear|drop)\b/i,
	/\bdrop\s+(table|database|schema|tablespace|owned)\b/i,
	/\btruncate\s+table\b/i,
	/\b(kubectl)\b[^\n]*\b(delete|apply)\b/i,
	/\bterraform\b[^\n]*\b(apply|destroy)\b/i,
	/\bhelm\b[^\n]*\b(upgrade|install|uninstall|delete|rollback)\b/i,
	/\bdd\b[^\n]*\bif=|\bdd\b[^\n]*\bof=/i,
	/\bmkfs(\.\w+)?\b/i,
	// Alias de mkfs / otras tools de formato de filesystem que reformatean un device.
	/\b(mke2fs|mkdosfs|mkntfs|mkswap|newfs)\b/i,
];

/** ¿Este comando bash está en la lista destructiva? */
export function isDestructiveBash(command: string): boolean {
	return DESTRUCTIVE_BASH_PATTERNS.some((re) => re.test(command));
}

// Redirecciones de shell que escriben un archivo (>, >>, forma clobber-override `>|`,
// opcionalmente con fd como 2>log), capturando la ruta target. Excluye fd-dups (>&, 2>&1)
// y operadores ->, =>, >= que no son redirecciones. El `\|?` tras `>>?` atrapa `>|`/`>>|`,
// que activan noclobber-override y si no pasarían (el `|` no es char válido de target).
export const REDIRECT_TARGET_RE = /(?:^|[^&>=\d-])\d*>>?\|?\s*(?![&>=])("[^"]*"|'[^']*'|[^\s|&;<>]+)/g;
// `&>` / `&>>` redirigen stdout+stderr a un archivo (bash). REDIRECT_TARGET_RE rechaza
// a propósito un `&` justo antes de `>` (para saltar fd-dups como 2>&1 / >&2), así que el
// operador de redirección combinada necesita patrón propio: `&` en posición de comando, luego `>`/`>>`.
export const AMP_REDIRECT_TARGET_RE = /(?:^|[\s;|&(])&>>?\s*(?![&>=])("[^"]*"|'[^']*'|[^\s|&;<>]+)/g;
// `>&file` / `N>&file` es la forma con `>` primero de la redirección combinada: bash envía ambos
// streams a <file> cuando la palabra tras `>&` no es número/`-` (número/`-` es fd-dup o close:
// 2>&1, >&2, >&-). AMP_REDIRECT_TARGET_RE solo matchea la forma `&>` con `&` primero, así que
// este espejo necesita patrón propio; el guard `(?![-\d&])` preserva exclusiones fd-dup.
export const GT_AMP_REDIRECT_TARGET_RE = /(?:^|[^&>=\d-])\d*>&\s*(?![-\d&])("[^"]*"|'[^']*'|[^\s|&;<>]+)/g;
// `tee [flags] <file...>` escribe cada archivo posicional. Captura toda la corrida de argumentos
// tras `tee` para que unsafeBashWriteTarget revise cada target, no solo el primero (una regex de
// una captura dejaba pasar el segundo target de `tee build/ok.log /etc/evil`).
export const TEE_ARGS_RE = /\btee\b((?:\s+(?:-\S+|"[^"]*"|'[^']*'|[^\s|&;<>]+))+)/gi;
// `cd`/`pushd` en posición de comando (inicio, o tras separador ;/&&/||/|/newline/`(`),
// capturando el operando de directorio opcional. Un `cd` suelto (sin operando) va a $HOME.
export const CD_TARGET_RE = /(?:^|[;&|\n(])[ \t]*(?:cd|pushd)\b[ \t]*("[^"]*"|'[^']*'|[^\s|&;<>]+)?/gi;

// ¿El comando hace `cd`/`pushd` a un directorio que no podemos probar dentro del proyecto?
// Si sí, todo target RELATIVO de redirect/tee ya no es demostrablemente in-project.
// Un `cd`, `cd -`, `cd ~`, `cd ..`, `cd /abs-outside` o `cd $VAR` califican.
export function commandChangesToUnsafeDir(ctx: ExtensionContext, command: string): boolean {
	for (const m of command.matchAll(CD_TARGET_RE)) {
		const raw = m[1];
		if (raw === undefined) return true; // `cd` suelto -> $HOME (fuera del proyecto)
		const dir = unquote(raw);
		if (dir === "" || dir === "-") return true; // `cd -` vuelve a un dir previo desconocido
		if (isUnsafeWritePath(ctx, dir)) return true; // absolute-outside, .., ~ inicial o $VAR
	}
	return false;
}

export function unquote(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function collectBashWriteTargets(command: string): string[] {
	const targets: string[] = [];
	for (const re of [REDIRECT_TARGET_RE, AMP_REDIRECT_TARGET_RE, GT_AMP_REDIRECT_TARGET_RE]) {
		for (const m of command.matchAll(re)) if (m[1]) targets.push(unquote(m[1]));
	}
	// `tee` puede listar varios archivos; revisar cada token no-flag en sus argumentos.
	for (const m of command.matchAll(TEE_ARGS_RE)) {
		if (!m[1]) continue;
		for (const tok of m[1].trim().split(/\s+/)) {
			if (tok.startsWith("-")) continue;
			targets.push(unquote(tok));
		}
	}
	return targets;
}

// Devuelve el primer target de redirect/tee de shell que escribe FUERA del proyecto, para que
// un comando bash no evada la misma guardia fuera-del-proyecto aplicada a write/edit.
export function unsafeBashWriteTarget(ctx: ExtensionContext, command: string): string | undefined {
	const targets = collectBashWriteTargets(command);
	const leftProject = commandChangesToUnsafeDir(ctx, command);
	for (const target of targets) {
		if (target.startsWith("/dev/")) continue; // /dev/null y similares no son escrituras reales
		if (isUnsafeWritePath(ctx, target)) return target;
		// Tras un `cd` fuera del proyecto, un target relativo también resuelve afuera.
		if (leftProject && !path.isAbsolute(target)) return target;
	}
	return undefined;
}

/** ¿Esta ruta write/edit es insegura (fuera del cwd confiable del proyecto, o escapa vía "..")? */
export function isUnsafeWritePath(ctx: ExtensionContext, filePath: unknown): boolean {
	if (typeof filePath !== "string" || filePath.length === 0) return false;
	// Quitar primero escapes backslash de shell: `> \/etc/x` llega como `\/etc/x`, que
	// path.normalize trata como nombre no absoluto (no empieza con `/`) y dejaría pasar.
	// Desescapar restaura el `/etc/x` real para disparar el chequeo absolute-outside.
	const p = filePath.replace(/\\(.)/g, "$1");
	// Un ~ inicial (home), variable de shell sin expandir ($VAR / ${VAR}) o sustitución de
	// comando ($(...) o `...`) no se puede probar dentro del proyecto: la shell expande eso
	// en runtime, path.normalize no. Tratarlo como fuera-del-proyecto, no como relativo inocuo.
	if (p.startsWith("~")) return true;
	if (/\$[\w{(]/.test(p)) return true;
	if (p.includes("`")) return true;
	// Rechazar toda ruta que salga del cwd vía "..".
	const normalized = path.normalize(p);
	if (normalized.split(path.sep).includes("..")) return true;
	if (path.isAbsolute(normalized)) {
		const root = path.resolve(ctx.cwd);
		const target = path.resolve(normalized);
		// Fuera de cwd -> inseguro. (Dentro de cwd -> trabajo normal del loop, permitido.)
		return target !== root && !target.startsWith(root + path.sep);
	}
	// Una ruta relativa sin ".." resuelve dentro de cwd -> segura.
	return false;
}

/**
 * Decide si una llamada de tool autopilot es una acción destructiva gateada. Devuelve una
 * razón legible cuando debe gatearse; si no, undefined. Pura (sin side effects), testeable.
 */
export function destructiveReason(ctx: ExtensionContext, event: ToolCallEvent): string | undefined {
	if (event.toolName === "bash") {
		const rawCommand = (event.input as { command?: unknown }).command;
		if (typeof rawCommand === "string") {
			// Colapsar continuaciones de línea con backslash a espacio ANTES del match: si no,
			// un comando partido en líneas (`rm \\<newline> -rf d`) oculta sus flags a patrones
			// anclados con [^\n]*. Esto refuerza todos los patrones a la vez.
			const command = rawCommand.replace(/\\\r?\n/g, " ");
			if (isDestructiveBash(command)) {
				return `autopilot bloqueó un comando de shell destructivo: ${command.slice(0, 200)}`;
			}
			const unsafeTarget = unsafeBashWriteTarget(ctx, command);
			if (unsafeTarget) {
				return `autopilot bloqueó una escritura de shell fuera del proyecto: ${unsafeTarget.slice(0, 200)}`;
			}
		}
		return undefined;
	}
	if (event.toolName === "write" || event.toolName === "edit") {
		const input = event.input as { file_path?: unknown; path?: unknown };
		const filePath = input.file_path ?? input.path;
		if (isUnsafeWritePath(ctx, filePath)) {
			return `autopilot bloqueó un ${event.toolName} fuera del proyecto: ${String(filePath).slice(0, 200)}`;
		}
		return undefined;
	}
	return undefined;
}
