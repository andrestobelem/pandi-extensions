/**
 * Patrones regex de comandos bash destructivos para el gate autopilot de pandi-loop.
 */

export const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
	/\brm\b(?=[^\n]*(\s-[a-z]*[rR]|\s--recursive\b))/i,
	/\bfind\b[^\n]*\s-delete\b/i,
	/\bfind\b[^\n]*-exec\s+(?:\S*\/)?rm\b/i,
	/\btruncate\b/i,
	/\bshred\b/i,
	/\bgit\b[^\n]*\bpush\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i,
	/\bgit\b[^\n]*\bpush\b[^\n]*\s\+[^\s]/i,
	/\bgit\b[^\n]*\bpush\b[^\n]*(--delete\b|--mirror\b|--prune\b)/i,
	/\bgit\b[^\n]*\bpush\b[^\n]*\s:\S/i,
	/\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i,
	/\bgit\b[^\n]*\bclean\b[^\n]*\s-[a-z]*f/i,
	/\bgit\b[^\n]*\bcheckout\b[^\n]*\s(?:-f\b|--force\b)/i,
	/\bgit\b[^\n]*\bfilter-branch\b/i,
	/\bgit\b[^\n]*\bstash\b[^\n]*\b(clear|drop)\b/i,
	/\bdrop\s+(table|database|schema|tablespace|owned)\b/i,
	/\btruncate\s+table\b/i,
	/\b(kubectl)\b[^\n]*\b(delete|apply)\b/i,
	/\bterraform\b[^\n]*\b(apply|destroy)\b/i,
	/\bhelm\b[^\n]*\b(upgrade|install|uninstall|delete|rollback)\b/i,
	/\bdd\b[^\n]*\bif=|\bdd\b[^\n]*\bof=/i,
	/\bmkfs(\.\w+)?\b/i,
	/\b(mke2fs|mkdosfs|mkntfs|mkswap|newfs)\b/i,
];

export function isDestructiveBash(command: string): boolean {
	return DESTRUCTIVE_BASH_PATTERNS.some((re) => re.test(command));
}
