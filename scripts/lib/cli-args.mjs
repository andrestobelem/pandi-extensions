export function parseCheckOnly(args = process.argv.slice(2)) {
	return args.includes("--check");
}

export function valueAfter(args, flag) {
	const eq = args.find((arg) => arg.startsWith(`${flag}=`));
	if (eq) return eq.slice(flag.length + 1);
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

export function parsePositiveInt(raw, fallback) {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) throw new Error(`invalid positive integer: ${raw}`);
	return value;
}
