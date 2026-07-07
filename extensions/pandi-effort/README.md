# @pandi-coding-agent/pandi-effort

Esta extensión agrega el comando `/effort` al estilo Claude para cambiar
cuánto piensa Pi — de `off` a `xhigh` — sin recorrer configuraciones. Úsala
cuando una tarea pida más razonamiento (subí a `high`/`xhigh`) o cuando
quieras turnos más rápidos y baratos (bajá a `low`/`off`). Un valor especial,
`ultracode`, activa `xhigh` y enciende el router de `dynamic_workflow` en un
solo comando.

```text
/effort high
→ Esfuerzo de pensamiento configurado en high.

/effort ultracode
→ Esfuerzo ultracode habilitado (xhigh); router de dynamic_workflow habilitado.
```

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-effort
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-effort             # global (tu usuario)
pi install -l ./extensions/pandi-effort           # local al proyecto
pi --no-extensions -e ./extensions/pandi-effort   # prueba puntual, sin cargar nada más
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/effort` | Abre un selector interactivo de niveles de esfuerzo. |
| `/effort status` | Muestra el esfuerzo de pensamiento actual. |
| `/effort off\|minimal\|low\|medium\|high\|xhigh` | Establece el nivel de pensamiento de Pi (`none` y `max` son alias de `off` y `xhigh`). |
| `/effort ultracode` | Establece `xhigh` y habilita el router Ultracode de Dynamic Workflows (cuando esa extensión está cargada). |

## Limitaciones y notas de seguridad

- `/effort ultracode` requiere la extensión `pandi-dynamic-workflows` — instalá `./extensions/pandi-dynamic-workflows` o el bundle raíz del repositorio.
- Bajar el nivel después (por ejemplo `/effort medium`) **no** apaga el router Ultracode: son cosas separadas. Desactivá el router con `/ultracode-mode off`.
- El modelo activo puede limitar el nivel pedido (los modelos sin reasoning pasan a `off`); el comando informa el nivel que realmente quedó activo.

## Relacionados

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
