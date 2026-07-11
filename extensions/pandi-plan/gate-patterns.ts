/**
 * Patrones regex de comandos bash mutantes para el gate de modo plan.
 * Heurística best-effort documentada en gate.ts; la clasificación principal usa
 * parsing estructurado en gate-shell-parse.ts + gate.ts.
 */

export const MUTATING_BASH_PATTERNS: RegExp[] = [
	// Creación/borrado/movimiento/cambios de metadata de archivo (cualquier bandera). \brm\b también cubre rm -rf.
	/\btouch\b/i,
	/\bmkdir\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bln\b/i,
	/\binstall\b/i, // GNU coreutils `install` crea archivos; también re-cubre npm/pip install
	/\btruncate\b/i,
	/\bshred\b/i,
	/\bunlink\b/i,
	// Herramientas in-place / de escritura de archivos.
	/\bsed\b[^\n]*\s-i\b/i, // sed -i (edición in-place)
	/\btee\b/i,
	/\bdd\b[^\n]*\b(if|of)=/i,
	/\bmkfs(\.\w+)?\b/i,
	// Los redireccionamientos de shell se checkean por hasWritingRedirection abajo, porque la versión regex
	// no pudía distinguir `> file` de un patrón grep de solo lectura quoted.
	// Mutaciones de Git.
	/\bgit\b[^\n]*\b(commit|add|push|pull|clone|fetch|reset|clean|checkout|switch|restore|merge|rebase|stash|apply|rm|mv|tag|cherry-pick|revert)\b/i,
	/\bgit\b[^\n]*\bbranch\b[^\n]*\s-(?:[dDmMcC]|-delete|-move|-copy|-set-upstream-to|-unset-upstream|-create-reflog|-track)\b/i,
	/\bgit\b[^\n]*\bbranch\b\s+(?!-)(?:"[^"]+"|'[^']+'|[^\s;|&]+)/i,
	// Instalaciones de package.
	/\b(npm|pnpm|yarn|bun)\b[^\n]*\b(install|add|ci|uninstall|remove|update|upgrade|prune)\b/i,
	/\bnpx\b[^\n]*\s-y\b/i,
	/\b(pip|pip3|pipx)\b[^\n]*\binstall\b/i,
	/\bpoetry\b[^\n]*\badd\b/i,
	/\bcargo\b[^\n]*\badd\b/i,
	/\bgo\b[^\n]*\bget\b/i,
	/\bgem\b[^\n]*\binstall\b/i,
	/\bbrew\b[^\n]*\binstall\b/i,
	// Infra / build que escribe.
	/\bmake\b/i,
	/\bkubectl\b[^\n]*\b(apply|delete)\b/i,
	/\bterraform\b[^\n]*\b(apply|destroy)\b/i,
	/\bhelm\b[^\n]*\b(upgrade|install|uninstall)\b/i,
];
