/**
 * pi-container: manage Apple `container` sandboxes (Linux micro-VMs) from inside Pi.
 *
 * Two surfaces (the project convention, see pi-worktree):
 *   - `/container`           human slash command (interactive, confirms destructive ops)
 *   - `container_sandbox`    model-callable tool (explicit actions, no surprise deletes)
 *
 * Both share the pure helpers + handlers in ./container.ts. `container` is always
 * spawned with an ARGV array (never a shell string) so image refs / machine names /
 * commands can't inject shell.
 *
 * Apple `container` runs each Linux environment in its own lightweight VM
 * (Virtualization.framework) and requires macOS on Apple Silicon, the `container`
 * CLI (`brew install container`), a configured kernel, and a booted subsystem.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type HandlerResult,
	isSupportedPlatform,
	runContainer,
	runCreate,
	runExec,
	runList,
	runRemove,
	runStatus,
	runStop,
} from "./container.js";
import { notify } from "./notify.js";

// Re-exported so the integration suite can unit-test the pure helpers + handlers
// directly against the same built bundle.
export {
	buildEphemeralRunArgs,
	buildMachineCreateArgs,
	buildMachineExecArgs,
	buildMachineListArgs,
	buildRemoveArgs,
	buildStatusArgs,
	buildStopArgs,
	describeMachine,
	formatMachineList,
	humanBytes,
	isSupportedPlatform,
	parseMachineList,
	runContainer,
	runCreate,
	runExec,
	runList,
	runRemove,
	runStatus,
	runStop,
	validateMachineName,
} from "./container.js";

const SUBCOMMANDS = ["status", "list", "create", "run", "stop", "remove"] as const;

const HELP_TEXT = [
	"Usage:",
	"  /container [status]                         subsystem + machine overview",
	"  /container list                            list container machines",
	"  /container create <image> [name]           create a machine (e.g. alpine:latest dev)",
	"  /container run <machine> -- <cmd...>       run a command inside a machine",
	"  /container stop [name]                     stop a machine (default if omitted)",
	"  /container remove <name>                   delete a machine (confirms first)",
	"",
	"Apple `container` needs macOS on Apple Silicon, `brew install container`, a",
	"configured kernel (`container system kernel set --recommended`), and a booted",
	"subsystem (`container system start`).",
].join("\n");

const PLATFORM_MSG = "Apple `container` requires macOS on Apple Silicon (arm64); this host is not supported.";

/** Human-labelled options for the bare `/container` action selector (first token is the value). */
export const CONTAINER_SELECT_ITEMS = [
	"status — subsystem + machine overview",
	"list — list container machines",
	"create — create a machine from an OCI image",
	"run — run a command in a machine or an ephemeral container",
	"stop — stop a machine",
	"remove — delete a machine (asks for confirmation)",
];

/**
 * Resolve the `/container` argument, opening an interactive action selector when the
 * command is invoked bare in a session with a UI. Headless (no UI) and explicit args
 * keep the unchanged behavior, so nothing regresses off-TUI. Cancelling returns "",
 * which `runCommand` renders as the help text.
 */
export async function resolveContainerInput(input: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = input.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui?.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Container action", CONTAINER_SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "";
}

// --------------------------------------------------------------------------
// Command parsing (tiny, local — no shared runtime imports)
// --------------------------------------------------------------------------

/** Split a command line into the subcommand and the rest, honoring a `--` argv separator. */
export function parseContainerCommand(input: string): {
	action: string;
	rest: string[];
	command: string[];
} {
	const trimmed = (input ?? "").trim();
	const sepIndex = trimmed.indexOf(" -- ");
	const head = sepIndex >= 0 ? trimmed.slice(0, sepIndex) : trimmed;
	const command =
		sepIndex >= 0
			? trimmed
					.slice(sepIndex + 4)
					.trim()
					.split(/\s+/)
					.filter(Boolean)
			: [];
	const tokens = head.split(/\s+/).filter(Boolean);
	const action = (tokens.shift() ?? "status").toLowerCase();
	return { action, rest: tokens, command };
}

// --------------------------------------------------------------------------
// Command handler
// --------------------------------------------------------------------------

async function runCommand(ctx: ExtensionContext, input: string): Promise<void> {
	if (!isSupportedPlatform()) {
		notify(ctx, PLATFORM_MSG, "error");
		return;
	}
	const { action, rest, command } = parseContainerCommand(await resolveContainerInput(input, ctx));
	const opts = { cwd: ctx.cwd, signal: ctx.signal ?? undefined };

	if (action === "help" || action === "-h" || action === "--help") {
		notify(ctx, HELP_TEXT, "info");
		return;
	}

	let result: HandlerResult;
	switch (action) {
		case "status":
			result = await runStatus(runContainer, opts);
			break;
		case "list":
		case "ls":
			result = await runList(runContainer, opts);
			break;
		case "create":
			result = await runCreate(runContainer, { image: rest[0] ?? "", name: rest[1] }, opts);
			break;
		case "run":
		case "exec":
			result = await runExec(runContainer, { machine: rest[0], command }, opts);
			break;
		case "stop":
			result = await runStop(runContainer, { name: rest[0] }, opts);
			break;
		case "remove":
		case "rm":
		case "delete": {
			const name = rest[0] ?? "";
			const confirmed = ctx.hasUI
				? await ctx.ui.confirm("Delete container machine?", `This permanently deletes machine "${name}".`)
				: false;
			result = await runRemove(runContainer, { name, force: confirmed }, opts);
			break;
		}
		default:
			notify(ctx, `Unknown subcommand: ${action}\n\n${HELP_TEXT}`, "warning");
			return;
	}
	notify(ctx, result.text, result.ok ? "info" : "error");
}

// --------------------------------------------------------------------------
// Tool result helper
// --------------------------------------------------------------------------

function toToolResult(result: HandlerResult) {
	return {
		content: [{ type: "text" as const, text: result.text }],
		details: result.details,
	};
}

// --------------------------------------------------------------------------
// Extension entry
// --------------------------------------------------------------------------

export default function containerExtension(pi: ExtensionAPI): void {
	pi.registerCommand("container", {
		description: "Manage Apple container sandboxes: status | list | create | run | stop | remove",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/);
			if (tokens.length > 1) return null;
			const needle = (tokens[0] ?? "").toLowerCase();
			const items = SUBCOMMANDS.filter((sub) => sub.startsWith(needle));
			return items.length > 0 ? items.map((sub) => ({ value: sub, label: sub })) : null;
		},
		handler: async (args, ctx) => {
			await runCommand(ctx, args);
		},
	});

	pi.registerTool({
		name: "container_sandbox",
		label: "Container Sandbox",
		description:
			"Manage Apple `container` sandboxes (Linux environments in lightweight micro-VMs) on macOS/Apple Silicon. Actions: 'status' (subsystem + machine overview), 'list' (list container machines), 'create' (create a machine from an OCI image), 'run' (run a command isolated inside an existing machine OR an ephemeral container), 'stop' (stop a machine), 'remove' (delete a machine; requires force). `container` is invoked with an argv array, never a shell.",
		promptSnippet: "Manage Apple container sandboxes: status/list/create/run/stop/remove Linux micro-VMs.",
		promptGuidelines: [
			"Use container_sandbox to run untrusted or isolated Linux commands inside Apple `container` micro-VMs instead of running them directly on the host.",
			"For action 'run', pass 'command' as an argv array (e.g. [\"uname\",\"-a\"]) plus either 'machine' (an existing machine) or 'image' (ephemeral container). Never embed a shell string.",
			"container_sandbox 'remove' never deletes by default: only pass force:true when the user explicitly accepts deleting the machine.",
			"Apple `container` needs macOS on Apple Silicon, `brew install container`, a configured kernel, and a booted subsystem; surface the install/start guidance instead of retrying blindly.",
		],
		parameters: Type.Object({
			action: StringEnum(["status", "list", "create", "run", "stop", "remove"] as const),
			name: Type.Optional(Type.String({ description: "Machine name (for create/stop/remove, or run target)." })),
			image: Type.Optional(
				Type.String({ description: "OCI image (for create, or ephemeral run), e.g. alpine:latest." }),
			),
			command: Type.Optional(
				Type.Array(Type.String(), { description: 'For run: the command as an argv array (e.g. ["uname","-a"]).' }),
			),
			machine: Type.Optional(
				Type.String({ description: "For run: existing machine to run inside (else ephemeral via image)." }),
			),
			workdir: Type.Optional(Type.String({ description: "For run: working directory inside the container." })),
			cpus: Type.Optional(Type.Number({ description: "For create: number of virtual CPUs." })),
			memory: Type.Optional(Type.String({ description: "For create: memory allocation, e.g. 8G." })),
			homeMount: Type.Optional(StringEnum(["ro", "rw", "none"] as const)),
			setDefault: Type.Optional(Type.Boolean({ description: "For create: set this machine as the default." })),
			force: Type.Optional(Type.Boolean({ description: "For remove: confirm deleting the machine." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!isSupportedPlatform()) {
				return {
					content: [{ type: "text" as const, text: PLATFORM_MSG }],
					details: { isError: true, action: params.action },
				};
			}
			const opts = { cwd: ctx.cwd, signal: signal ?? undefined };
			switch (params.action) {
				case "status":
					return toToolResult(await runStatus(runContainer, opts));
				case "list":
					return toToolResult(await runList(runContainer, opts));
				case "create":
					return toToolResult(
						await runCreate(
							runContainer,
							{
								image: params.image ?? "",
								name: params.name,
								cpus: params.cpus,
								memory: params.memory,
								homeMount: params.homeMount,
								setDefault: params.setDefault,
							},
							opts,
						),
					);
				case "run":
					return toToolResult(
						await runExec(
							runContainer,
							{
								command: params.command ?? [],
								machine: params.machine ?? params.name,
								image: params.image,
								workdir: params.workdir,
							},
							opts,
						),
					);
				case "stop":
					return toToolResult(await runStop(runContainer, { name: params.name }, opts));
				case "remove":
					return toToolResult(
						await runRemove(runContainer, { name: params.name ?? "", force: params.force }, opts),
					);
				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
						details: { isError: true },
					};
			}
		},
	});
}
