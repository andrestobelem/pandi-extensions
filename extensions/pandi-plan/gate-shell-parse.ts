/**
 * Helpers de parsing shell para el gate de modo plan (best-effort, sin parser completo).
 */

function firstNonWhitespaceAfter(command: string, start: number): string | undefined {
	for (let i = start; i < command.length; i++) {
		if (!/\s/.test(command[i])) return command[i];
	}
	return undefined;
}

function readShellToken(command: string, start: number): string | undefined {
	let inSingle = false;
	let inDouble = false;
	let token = "";

	for (let i = start; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !inSingle) {
			if (i + 1 < command.length) token += command[i + 1];
			i += 1;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "&")) break;
		token += ch;
	}

	return token || undefined;
}

export function hasWritingRedirection(command: string): boolean {
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !inSingle) {
			i += 1;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble || ch !== ">") continue;

		const prev = command[i - 1];
		const next = command[i + 1];
		if (prev === "-" || prev === "=" || next === "=") continue; // ->, =>, >=
		if (next === "&") {
			const targetStart = firstNonWhitespaceAfter(command, i + 2);
			if (targetStart === undefined || /[-\d&]/.test(targetStart)) continue; // fd dup/close: 2>&1, >&2, >&-
		}

		let targetOffset = 1;
		if (next === ">" || next === "|") targetOffset = 2; // >>file, >|file
		const target = readShellToken(command, i + targetOffset);
		if (target === "/dev/null") continue;
		return true;
	}

	return false;
}

export function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let inSingle = false;
	let inDouble = false;
	let start = 0;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !inSingle) {
			i += 1;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble) continue;

		const next = command[i + 1];
		const isSeparator = ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && next === "&");
		if (!isSeparator || (ch === "|" && command[i - 1] === ">")) continue;

		const segment = command.slice(start, i).trim();
		if (segment) segments.push(segment);
		start = i + (ch === "&" && next === "&" ? 2 : 1);
		if (ch === "&" && next === "&") i += 1;
	}

	const last = command.slice(start).trim();
	if (last) segments.push(last);
	return segments;
}

export function shellWords(segment: string): string[] {
	const words: string[] = [];
	let inSingle = false;
	let inDouble = false;
	let current = "";

	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\\" && !inSingle) {
			if (i + 1 < segment.length) current += segment[i + 1];
			i += 1;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && /\s/.test(ch)) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += ch;
	}

	if (current) words.push(current);
	return words;
}

export function commandBasename(token: string | undefined): string {
	return (token ?? "").split("/").pop() ?? "";
}

export function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

export function firstCommandIndex(words: string[], start = 0): number {
	let index = start;
	while (index < words.length && isEnvAssignment(words[index])) index += 1;
	return index;
}

export function hasSedInPlaceFlag(words: string[]): boolean {
	return words.some((word) => /^-[A-Za-z]*i[A-Za-z]*$/.test(word));
}

export function hasAny(words: string[], values: Set<string>): boolean {
	return words.some((word) => values.has(word));
}

export function hasDownloadOutputFlag(args: string[]): boolean {
	return args.some(
		(arg) =>
			arg === "-o" ||
			arg === "-O" ||
			arg === "--output" ||
			arg === "--remote-name" ||
			arg.startsWith("--output=") ||
			/^-[A-Za-z]*[oO][A-Za-z]*$/.test(arg),
	);
}

export function firstXargsCommandIndex(words: string[], xargsIndex: number): number | undefined {
	for (let index = xargsIndex + 1; index < words.length; index++) {
		if (words[index].startsWith("-")) {
			if (["-a", "--arg-file", "-E", "-I", "-i", "-L", "-l", "-n", "-P", "-s"].includes(words[index])) index += 1;
			continue;
		}
		return index;
	}
	return undefined;
}
