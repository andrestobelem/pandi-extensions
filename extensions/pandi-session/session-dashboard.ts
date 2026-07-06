import type { PandiSessionModel } from "./session-registry.js";

interface DashboardTheme {
	bold?: (value: string) => string;
}

export type PandiSessionDashboardResult =
	| { type: "switchSession"; session: PandiSessionModel }
	| { type: "cleanup" }
	| null;

function clip(text: string | undefined, max: number): string {
	const value = (text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text.slice(0, width) : `${text}${" ".repeat(width - text.length)}`;
}

function sessionLabel(session: PandiSessionModel): string {
	return session.sessionName ?? session.sessionId ?? session.id;
}

function statusLabel(session: PandiSessionModel): string {
	if (session.live) return session.current ? "current" : "live";
	return `stale:${session.staleReason ?? "unknown"}`;
}

function isEnter(data: string): boolean {
	return data === "enter" || data === "\r" || data === "\n";
}

function isEscape(data: string): boolean {
	return data === "escape" || data === "\u001b";
}

export class PandiSessionDashboard {
	private sessions: PandiSessionModel[];
	private selected = 0;
	private refreshError: string | undefined;

	constructor(
		sessions: PandiSessionModel[],
		private readonly theme: DashboardTheme,
		private readonly requestRender: () => void,
		private readonly done: (result: PandiSessionDashboardResult) => void,
	) {
		this.sessions = sessions;
	}

	private styledHeader(text: string): string {
		return this.theme.bold?.(text) ?? text;
	}

	setSessions(next: PandiSessionModel[]): void {
		const previous = this.sessions[this.selected];
		this.sessions = next;
		if (previous) {
			const found = next.findIndex((session) => session.id === previous.id);
			this.selected = found >= 0 ? found : Math.min(this.selected, Math.max(0, next.length - 1));
		} else {
			this.selected = Math.min(this.selected, Math.max(0, next.length - 1));
		}
	}

	markRefreshOk(): void {
		this.refreshError = undefined;
	}

	markRefreshError(message: string): void {
		this.refreshError = message;
	}

	invalidate(): void {
		/* render state is derived from sessions + selected index */
	}

	handleInput(data: string): void {
		if (data === "q" || isEscape(data)) {
			this.done(null);
			return;
		}
		if (data === "C" || data === "c") {
			this.done({ type: "cleanup" });
			return;
		}
		if (isEnter(data) || data === "right" || data === "\u001b[C") {
			const session = this.sessions[this.selected];
			if (session) this.done({ type: "switchSession", session });
			return;
		}
		if (data === "down" || data === "j" || data === "\u001b[B") {
			this.selected = Math.min(this.sessions.length - 1, this.selected + 1);
			this.requestRender();
			return;
		}
		if (data === "up" || data === "k" || data === "\u001b[A") {
			this.selected = Math.max(0, this.selected - 1);
			this.requestRender();
		}
	}

	render(width = 100): string[] {
		const safeWidth = Math.max(60, width);
		const live = this.sessions.filter((session) => session.live).length;
		const stale = this.sessions.length - live;
		const current = this.sessions.filter((session) => session.current).length;
		const lines: string[] = [
			this.styledHeader(
				`Pandi sessions · total:${this.sessions.length} live:${live} stale:${stale} current:${current}`,
			),
			"",
		];
		if (this.refreshError) lines.push(`refresh warning: ${clip(this.refreshError, safeWidth - 17)}`, "");
		if (this.sessions.length === 0) {
			lines.push("No hay sesiones Pandi registradas para este proyecto.");
			return lines;
		}
		for (const [index, session] of this.sessions.entries()) {
			const cursor = index === this.selected ? "›" : " ";
			const currentMark = session.current ? "★" : " ";
			const row = `${cursor} ${currentMark} ${pad(statusLabel(session), 18)} ${pad(clip(sessionLabel(session), 28), 28)} ${clip(session.cwd, safeWidth - 54)}`;
			lines.push(row);
		}
		const selected = this.sessions[this.selected];
		if (selected) {
			lines.push(
				"",
				this.styledHeader("Selected Pandi session"),
				`id: ${selected.id}`,
				`session: ${selected.sessionId ?? "(unknown)"}`,
				`file: ${selected.sessionFile ?? selected.file}`,
				`cwd: ${selected.cwd}`,
				`updated: ${selected.updatedAt}`,
				`state: ${statusLabel(selected)}`,
				"",
				"↑/↓ j/k seleccionar · Enter/→ cambiar · C limpiar stale · q cerrar",
			);
		}
		return lines.map((line) => line.slice(0, safeWidth));
	}
}
