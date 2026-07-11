# @pandi-coding-agent/pandi-personas

## En 30 segundos

`pandi-personas` empaqueta las personas advisor de Pandi para subagentes de `pandi-dynamic-workflows`:
`andrej-karpathy`, `dave-farley`, `kent-beck` y `uncle-bob`.

Pi no tiene un recurso nativo `pi.personas`; por eso este package carga una extensión liviana que registra su carpeta
`personas/` para que `pandi-dynamic-workflows` pueda resolverlas con `agentType`.

```js
const review = await agent("Revisá este diseño", {
  agentType: "kent-beck",
  tools: ["read", "grep", "find", "ls"],
});
```

## Instalación

```bash
pi install npm:@pandi-coding-agent/pandi-personas
```

También podés instalarlo localmente desde el repo:

```bash
pi install ./extensions/pandi-personas
```

Necesitás tener cargado `pandi-dynamic-workflows`; este package solo provee las personas empaquetadas.

## Precedencia

Cuando pedís `agentType: "kent-beck"`, el runtime busca en este orden:

1. `.pi/personas/kent-beck.json` del proyecto trusted.
2. Personas registradas por packages como este.
3. Personas built-in de `pandi-dynamic-workflows` (`reviewer`, `planner`, etc.).

Así podés instalar defaults útiles y seguir sobreescribiendo una persona por proyecto cuando haga falta.
