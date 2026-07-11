export const PANDI_SESSION_ACTIONS = [
	{ value: "dashboard", description: "abrir el panel de sesiones" },
	{ value: "list", description: "listar las sesiones del proyecto" },
	{ value: "cleanup", description: "limpiar registros stale seguros" },
] as const;

function formatPandiSessionSelectItem(action: (typeof PANDI_SESSION_ACTIONS)[number]): string {
	return `${action.value} — ${action.description}`;
}

export const PANDI_SESSION_SELECT_ITEMS = PANDI_SESSION_ACTIONS.map(formatPandiSessionSelectItem);

export function selectedPandiSessionActionValue(choice: string | undefined): string | undefined {
	if (choice === undefined) return undefined;
	const action = PANDI_SESSION_ACTIONS.find((candidate) => choice === formatPandiSessionSelectItem(candidate));
	return action?.value ?? choice.split(/\s+/)[0];
}
