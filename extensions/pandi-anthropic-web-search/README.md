# @pandi-coding-agent/pandi-anthropic-web-search

Agrega la búsqueda web nativa de Anthropic a los requests de Pi que usan la API
`anthropic-messages`. No registra una tool local: modifica el payload ya serializado antes de que llegue al proveedor.

## Inicio rápido

Instalá esta extensión por separado:

```bash
pi install npm:@pandi-coding-agent/pandi-anthropic-web-search
```

O instalá el paquete completo desde este repositorio; la extensión se carga automáticamente:

```bash
pi install git:github.com/andrestobelem/pandi-extensions
```

Reiniciá Pi o ejecutá `/reload`. Con un modelo Anthropic, la extensión inyecta:

```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 8
}
```

Si ya existe una variante nativa `web_search_*`, la conserva. Si existe un tool de función llamado `web_search` —por ejemplo,
el provisto por `pi-codex-web-search`— lo reemplaza para evitar la colisión de nombres.

## Configuración

| Variable | Efecto |
| --- | --- |
| `PI_ANTHROPIC_WEB_SEARCH=off` | Desactiva la extensión. Cualquier valor no reconocido mantiene el valor por defecto: activada. |
| `PI_ANTHROPIC_WEB_SEARCH_ALLOWED_DOMAINS=docs.anthropic.com,example.com` | Restringe las búsquedas a dominios permitidos. |
| `PI_ANTHROPIC_WEB_SEARCH_BLOCKED_DOMAINS=spam.example,ads.example` | Excluye dominios de las búsquedas. |

## Límites

- Solo actúa sobre requests con API `anthropic-messages`; deja intactos otros proveedores.
- El proveedor Anthropic aplica disponibilidad, precios y límites de uso de la búsqueda nativa.
- `max_uses` está fijado en 8, igual que la extensión upstream de origen.

## Procedencia

Este paquete vendoriza y adapta
[`code-yeongyu/pi-anthropic-web-search`](https://github.com/code-yeongyu/pi-anthropic-web-search) en el commit
`366396e13abb05a2955d1f66ab703afa1fddee67`, bajo licencia MIT. Ver [`LICENSE`](./LICENSE) y [`NOTICE`](./NOTICE).
