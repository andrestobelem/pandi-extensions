# Configuración local de Pi

Fecha: 2026-06-25

## Compaction

Se probó configurar compaction automática alrededor del 60% de uso, primero con valores decimales y luego con valores binarios.

Decisión final del usuario: volver al comportamiento original/default de Pi.

Archivo actual:

```text
.pi/settings.json
```

Contenido actual:

```json
{
  "packages": [
    ".."
  ]
}
```

Esto significa que no hay override local de compaction en este proyecto. Pi usa sus defaults globales:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

Regla de Pi:

```text
contextTokens > contextWindow - reserveTokens
```
