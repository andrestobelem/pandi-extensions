# @pandi-coding-agent/pandi-podman

Corré una orden puntual en un contenedor Podman efímero sin abrir una superficie genérica de Docker/Podman. Usalo cuando
necesitás una herramienta Linux acotada y descartable; para administrar imágenes, volúmenes, builds o deploys, usá la
CLI de Podman directamente. La extensión usa argv, nunca shell, y su `run` no puede montar el host, publicar puertos ni
elevar privilegios. 🐼

## Inicio rápido

```bash
/podman status
/podman run quay.io/podman/hello:latest -- /hello
/podman list
```

El `run` usa red aislada por defecto. Cuando una tarea realmente necesita red dentro del contenedor, hacelo explícito:

```bash
/podman run --network default alpine:latest -- wget -qO- https://example.com
```

## Instalación

```bash
# Desde npm
pi install npm:@pandi-coding-agent/pandi-podman

# Desde este repositorio
pi install ./extensions/pandi-podman
pi install -l ./extensions/pandi-podman
pi --no-extensions -e ./extensions/pandi-podman
```

Instalá Podman por separado: en macOS, `brew install podman`; en Linux, usá el gestor de paquetes de la distribución.
macOS y Windows ejecutan contenedores dentro de una Podman machine; iniciala una vez con `podman machine init` y usá
`/podman machine-start` cuando esté detenida.

## Superficie

| Surface          | Acciones                                                                   | Para qué                                                              |
| ---------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `/podman`        | `status`, `list`, `run`, `stop`, `remove`, `machine-list`, `machine-start` | Operación humana, selector en TUI y confirmación para borrar.         |
| `podman_sandbox` | Las mismas acciones explícitas                                             | Tool del modelo, con `command: string[]` y `force: true` para borrar. |

### Comandos

```text
/podman [status]
/podman list
/podman run [--network none|default] <image> -- <cmd...>
/podman stop <container>
/podman remove <container>
/podman machine-list
/podman machine-start [name]
```

`/podman` sin argumentos abre el selector de acciones en la TUI; fuera de ella equivale a `status`. `remove` pide
confirmación y no elimina nada en modo headless.

### Tool `podman_sandbox`

La tool recibe una `action` y solo estos campos para `run`:

| Campo            | Significado                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `image`          | Referencia OCI, por ejemplo `quay.io/podman/hello:latest`.       |
| `command`        | Array argv obligatorio, por ejemplo `["uname", "-a"]`.           |
| `network`        | `none` por defecto; `default` es opt-in explícito.               |
| `workdir`        | Ruta absoluta dentro del contenedor.                             |
| `cpus`, `memory` | Límites que solo pueden endurecer los defaults de 2 CPU y 1G.    |
| `name`           | Contenedor para `stop`/`remove`, o máquina para `machine-start`. |
| `force`          | Obligatorio para `remove`.                                       |

Ejemplo mínimo:

```jsonc
{
  "action": "run",
  "image": "quay.io/podman/hello:latest",
  "command": ["/hello"],
}
```

## Política del sandbox

Cada `run` genera este tipo de ejecución: contenedor efímero (`--rm`), sin red por defecto, filesystem raíz read-only,
`/tmp` temporal, `--cap-drop ALL`, `no-new-privileges`, 256 PIDs, 2 CPU y 1G de memoria. La extensión no expone
mounts/volumes, puertos, variables de entorno, devices, capabilities extra, `--privileged` ni flags libres.

| Necesitás…                                  | Elegí                                      |
| ------------------------------------------- | ------------------------------------------ |
| Ejecutar una orden aislada y descartable    | `podman_sandbox` / `/podman run`           |
| Red dentro de un run puntual                | `network: "default"` / `--network default` |
| Un contenedor existente                     | `/podman list`, `stop` o `remove`          |
| Imágenes, mounts, puertos, builds o compose | La CLI `podman` directa                    |
| Una micro-VM Apple para código no confiable | `container_sandbox` de `pandi-container`   |

## Seguridad y límites

- Podman no es una frontera de seguridad infalible contra código hostil, especialmente en Linux. Evaluá la confianza de
  la imagen y del comando antes de ejecutarlos.
- Aunque el contenedor no recibe mounts del host, un pull de imagen y un `run` tienen efectos operativos en el almacén
  de Podman. La extensión no intenta ocultarlo.
- `remove` solo avanza con una confirmación TUI o `force: true` explícito en la tool. `stop` y `machine-start` no son
  destructivos, pero sí cambian estado.
- En macOS/Windows, `status` muestra las máquinas disponibles aunque la conexión de Podman esté caída y propone
  `/podman machine-start`.
- Cada llamada tiene un timeout de 120 s; `PI_PODMAN_TIMEOUT_MS` permite ampliarlo para pulls lentos o comandos
  legítimamente largos.

## Desarrollo

La suite no crea contenedores reales: prueba argv exactos, fixtures JSON, handlers con runner inyectado y abort/CLI
ausente reales. Corréla en forma aislada:

```bash
node --test extensions/pandi-podman/tests/integration/podman-extension.test.mjs
```

Después verificá TypeScript, Markdown y los syncs del paquete antes de probar una sesión Pi viva en un worktree aparte.
