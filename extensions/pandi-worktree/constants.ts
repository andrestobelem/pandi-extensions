import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const WORKTREE_ACTIONS = [
	{ value: "list", selectLabel: "list — listar worktrees" },
	{ value: "add", selectLabel: "add — crear un worktree" },
	{ value: "open" },
	{ value: "remove", selectLabel: "remove — eliminar un worktree" },
	{ value: "prune", selectLabel: "prune — limpiar metadatos obsoletos" },
	{ value: "set" },
	{ value: "help" },
] as const;

export const SUBCOMMANDS = WORKTREE_ACTIONS.map(({ value }) => value);
export const WORKTREE_ARGUMENT_COMPLETIONS = SUBCOMMANDS.map((sub) => ({ value: sub, label: sub }));
export const TOOL_ACTIONS = WORKTREE_ACTIONS.filter(({ value }) => value !== "set" && value !== "help").map(
	({ value }) => value,
);
export const WORKTREE_SELECT_ITEMS = WORKTREE_ACTIONS.flatMap((action) =>
	"selectLabel" in action ? [action.selectLabel] : [],
);

export const HELP_TEXT = [
	"Uso:",
	"  /worktree [list]                       listar worktrees",
	"  /worktree add [-b <branch>] [--detach] [--force] [--copy-ignored] [--copy-untracked] <path> [<commit-ish>]   crear un worktree",
	"  /worktree open [-b <branch>] [--detach] [--force] <path> [<commit-ish>]  si falta, crearlo y luego abrir Pi ahí",
	"  /worktree remove [--force] <path>      eliminar un worktree",
	"  /worktree prune [--dry-run]            limpiar metadatos obsoletos de worktrees",
	"  /worktree set [copy-ignored|copy-untracked|writer-guard] [on|off|status]   definir preferencias de la sesión",
	"",
	"Pasá --copy-ignored/--copy-untracked (o --no-copy-ignored/--no-copy-untracked) para sobrescribirlo en esta llamada.",
	"O definí un valor por defecto de la sesión con `set` (también vía las env vars PI_WORKTREE_COPY_IGNORED / PI_WORKTREE_COPY_UNTRACKED).",
	"El guard de un solo escritor está desactivado por defecto; activalo con `/worktree set writer-guard on` o PI_WORKTREE_WRITER_GUARD=1.",
	"",
	`Un <name> simple (sin slash) se crea en ${CONFIG_DIR_NAME}/worktrees/<name> (gitignored).`,
	"Usá ./x, ../x, /abs o ~/x para una ubicación explícita.",
].join("\n");
