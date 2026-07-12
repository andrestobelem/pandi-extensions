# @pandi-coding-agent/pandi-doctor

Agrega `/doctor`, un atajo dentro de la sesión para correr el chequeo de entorno de `pandi-extensions`. Sirve para
responder “¿mi máquina está bien configurada?” sin salir del chat. Usa el mismo reporte de solo lectura que
`npm run doctor`, a un comando de distancia.

## Inicio rápido

```text
/doctor
```

```text
pandi-extensions doctor

Obligatorios:
  ✓ Node.js 22.19.0 — ≥ 22.19.0
...

✓ Todos los requisitos obligatorios están presentes.
```

El comando busca `scripts/doctor.mjs`, lo ejecuta y muestra el reporte como un mensaje `info` (si pasan todos los
controles obligatorios), `error` (si el script sale con código distinto de cero o vence el tiempo) o `warning` (si no
encuentra el script).

## Instalación

| Modo              | Comando                                           | Cuándo usarlo                           |
| ----------------- | ------------------------------------------------- | --------------------------------------- |
| Desde npm         | `pi install npm:@pandi-coding-agent/pandi-doctor` | Uso independiente, fuera de este repo   |
| Global            | `pi install ./extensions/pandi-doctor`            | Querés `/doctor` en todas las sesiones  |
| Local al proyecto | `pi install -l ./extensions/pandi-doctor`         | Solo este proyecto debe tener `/doctor` |
| Prueba puntual    | `pi --no-extensions -e ./extensions/pandi-doctor` | Querés probarlo sin cargar nada más     |

## Comandos

| Comando   | Qué hace                                                                   |
| --------- | -------------------------------------------------------------------------- |
| `/doctor` | Ejecuta el chequeo de entorno (`scripts/doctor.mjs`) y muestra el reporte. |

## Cómo funciona

- Sube desde el cwd de la sesión buscando una copia del working tree
  (`<repo>/extensions/pandi-doctor/scripts/doctor.mjs`), así el desarrollo dentro del repo siempre usa la versión más
  nueva; si no, cae en la copia vendorizada que viene en el tarball de npm para instalaciones independientes.
- Lo ejecuta con `node` usando un array de argv — nunca una shell string — y captura la salida con `NO_COLOR` activado,
  así el reporte queda en texto plano.
- El handler pasa al proceso hijo el agent-dir, el directorio de configuración del proyecto y el binario efectivos de la
  distribución host. En Picante inspecciona su perfil aislado y prueba `picante`; en desarrollo,
  `PI_DYNAMIC_WORKFLOWS_PI_COMMAND` sigue teniendo precedencia para usar el wrapper local.
- En Windows, el probe ejecuta con `node.exe` el entrypoint declarado en `package.json#bin`, usando argv explícito y sin
  abrir una shell. En POSIX conserva el nombre nominal del binario.
- Los recursos opcionales se buscan en el agent-dir efectivo y en el proyecto de la sesión (`node_modules`, `.agents` y
  `<config-dir>/skills`). Sin overrides, el fallback vanilla sigue siendo `~/.pi/agent` y `pi`.
- Corre el script como un proceso hijo resuelto en runtime en vez de importarlo: un import estático rompería el
  bundling, así que la extensión siempre lo carga de forma dinámica.

## Límites y seguridad

- Las instalaciones independientes se degradan con honestidad: `sincronización global de Claude` reporta `N/A` fuera del
  repo de la suite, las consultas a `node_modules` locales usan el cwd de la sesión y el chequeo de doble copia saltea
  la detección del working tree.
- Bajo Picante o Pandi, la disponibilidad de packages y skills no se infiere desde el perfil vanilla `~/.pi`: el doctor
  sólo usa el perfil efectivo que recibió del host.
- Durante el onboarding, antes de `pi install ./` + `/reload`, usá `npm run doctor` en su lugar: `/doctor` solo existe
  una vez cargada la extensión.
- El proceso externo de `/doctor` vence a los 120 segundos y lo reporta como error. Podés sobrescribirlo con
  `PI_DOCTOR_TIMEOUT_MS` cuando un entorno más lento necesite más margen.
- Los probes internos también tienen límite: `PI_DOCTOR_PROBE_TIMEOUT_MS` controla los probes rápidos de binarios/git
  (por defecto 8s) y `PI_DOCTOR_SYNC_TIMEOUT_MS` controla los checks de sincronización del repo (por defecto 20s).
- Los overrides de timeout usan milisegundos y se clavan como mínimo en 1000ms; los valores inválidos vuelven a los
  defaults en vez de desactivar la protección.

## Relacionado

Para obtener el paquete completo de extensiones y skills, instalá la raíz del repositorio.
