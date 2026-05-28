<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/db-cluster/readme.png" alt="db-cluster" width="800" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/db-cluster/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/db-cluster/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@mcptoolshop/db-cluster"><img src="https://img.shields.io/npm/v/@mcptoolshop%2Fdb-cluster.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://mcp-tool-shop-org.github.io/db-cluster/handbook/"><img src="https://img.shields.io/badge/handbook-online-blue.svg" alt="Handbook" /></a>
</p>

**Clúster de base de datos federado nativo de IA.** Almacenes de datos especializados que funcionan como una única plataforma gestionada, con errores tipados, códigos de salida estructurados, recibos de mutaciones, API, SDK y CLI.

## ¿Para quién es esto?

- **Agentes de IA** que necesitan una recuperación confiable, envoltorios de errores estructurados y un ciclo de vida de mutación que no permita la corrupción silenciosa del estado.
- **Administradores** que utilizan almacenes de grafos y de trazabilidad y que desean códigos de salida tipados, diagnósticos de verificación, libros de procedimientos y copias de seguridad/restauraciones seguras.
- **Desarrolladores** que crean aplicaciones basadas en clústeres y que desean una API pública bien definida, pruebas de inicio rápidas y documentación JSDoc con ejemplos para cada método.
- **Usuarios de paneles de control** que auditan la integridad del clúster: propiedad del almacén, trazabilidad, vista previa de comandos y vista de enmascaramiento.

## ¿Por qué usar db-cluster?

- **Errores tipados con `remediationHint`** — cada subclase de `ClusterError` indica QUÉ HACER, no solo QUÉ falló (códigos de salida de la CLI 65/70/77/78 mapeados a códigos de error tipados).
- **Envoltorios de errores de IA** — esquema `{code, message, retryable, remediation_hint, context, next_valid_actions}`; los agentes de IA pueden bifurcarse según `code` y `retryable` en lugar de analizar texto.
- **Recibos para cada mutación** — direccionables por contenido; grafo de trazabilidad; contrato de reconstrucción a partir de la verdad en el almacén de índices.
- **Servidor MCP con anotaciones de seguridad** — las herramientas de solo lectura / en fases / aprobación / escritura incluyen las banderas de máquina legibles `readOnlyHint` / `destructiveHint`.
- **SDK con aplicación de políticas** — `PolicyEnforcedKernel` es la única vía; `ClusterKernel` no se exporta intencionalmente.

## Comienzo rápido (3 pasos)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

O instale globalmente y use directamente los binarios `db-cluster` y `db-cluster-mcp`:

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

O ejecute a través de Docker (no se requiere instalación de Node):

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

Ruta completa: [`docs/quickstart.md`](docs/quickstart.md) (5 minutos).

## ¿Qué es esto?

Un clúster de base de datos federado donde:

- **Almacén canónico** — entidades, ID, registros de estado estable.
- **Almacén de artefactos** — archivos sin procesar, documentos, texto fuente, resultados generados.
- **Almacén de índices** — capacidad de descubrimiento, búsqueda de texto completo/vectorial, búsqueda de metadatos.
- **Registro de eventos/trazabilidad** — acciones, enlaces, mutaciones, recibos, trazabilidad.

El kernel enruta. El índice descubre. El clúster posee la verdad.

## ¿Qué no es esto?

- Un asistente de base de datos de IA.
- Un índice sobre muchos almacenes.
- Middleware de gobernanza.
- Una base de datos vectorial con complementos.
- Una capa de memoria para agentes.

## Leyes de la arquitectura

1. Cada hecho tiene un almacén propietario.
2. Los índices son derivados; se pueden eliminar y reconstruir a partir de los almacenes propietarios.
3. La IA nunca muta el estado sin procesar directamente.
4. Cada respuesta se remonta a la fuente de la verdad.
5. Cada mutación cruza un límite de comando tipado.
6. La verdad de los artefactos es inmutable de forma predeterminada; las correcciones crean versiones, no sobrescrituras.
7. El kernel enruta; el clúster es el propietario.

## CLI

```bash
db-cluster init
db-cluster ingest ./source.md
db-cluster entity create ...
db-cluster find "..."
db-cluster inspect <id>
db-cluster trace <uri> [--direction] [--depth] [--graph]
db-cluster why <uri>
db-cluster lineage <uri>
db-cluster retrieve "..."
db-cluster trace-bundle "..."
db-cluster propose ...
db-cluster commit ...
db-cluster receipts
```

Consulte [`docs/cli.md`](docs/cli.md) para obtener la referencia completa de la CLI (incluida la tabla de códigos de salida de errores tipados).

## Estado

**v1.0.0 — disponible.** db-cluster está endurecido contra auditorías en todo el entorno de pruebas internas.
Protocolo — Etapa A (corrección, Olas A1–A4), Etapa B (salud proactiva,
Ola B1-Amend) y Etapa C (humanización, Ola C1-Amend).
**1247+ pruebas que pasan** de forma determinista en 83 archivos, puerta de lanzamiento 9/9
PASADA, limpieza de lint.

### ¿Qué hay en v1.0.0?

- **Modelo de verdad federado** — almacenes canónicos, artefactos, índices y registros; el kernel gestiona las rutas, el clúster es el propietario; el índice es derivado.
- **Errores con información de corrección (`remediationHint`) en todas partes** — clase base `ClusterError` y subclases específicas para cada clase; la CLI se mapea a sysexits.h (65/70/77/78); `AiErrorEnvelope` en cada límite de la IA.
- **Ciclo de vida de la mutación** — proponer → validar → aprobar → confirmar → (compensar). Cada confirmación genera un recibo con una dirección de contenido.
- **Servidor MCP** — 16 herramientas con anotaciones de seguridad (`readOnlyHint` / `destructiveHint` / `requiresApprovalHint`); resultados de errores estructurados, nunca trazas de pila sin formato.
- **Políticas y enmascaramiento** — `PolicyEnforcedKernel` es la única entrada de kernel exportada; tipos `Principal`, `Capability`, `Policy`, `TrustZone` y `VisibilityRule`; enmascaramiento en cada ruta de lectura.
- **Interfaz del operador** — `doctor`, `verify`, `reconstruir índice`, `copia de seguridad`, `restaurar`, `compensar`, `estado de migración`. Los comandos destructivos requieren la opción `--yes` y una confirmación interactiva en la terminal.
- **Demostración del panel de control** — panel de control de React solo para visualización del estado del clúster (`dashboard/`), con `ComponentState<T>` y `StateBoundary` HOC para los estados de carga, vacío y error.
- **Puerta de lanzamiento** — 9 etapas impuestas por `scripts/release-gate.mjs`: compilación, pruebas, empaquetado, instalación de prueba, detección de cambios en la documentación, exportación de paquetes, integridad, detección de cambios en la documentación y integridad de la documentación JSDoc.

### Residuos rastreados para v1.x

- `V2-C1-009` — Las operaciones MCP de larga duración (doctor/verify/rebuild/backup/restore) actualmente se presentan como herramientas de ejecución única; el streaming granular de progreso está documentado pero no está disponible en v1.0.0. Consulte [`docs/release-readiness.md`](docs/release-readiness.md).
- `KERNEL-C-012` — El canal `OperatorSignal` entre dominios es una extensión arquitectónica de v1.1+.
- Las pruebas de mutación de Stryker se incluyen (`npm run test:mutation`), pero son experimentales y no están incluidas en la puerta de lanzamiento estándar, según la doctrina del verificador-3 de la colmena de pruebas de v2.

### Historial de la colmena de pruebas

Etapa A (corrección, Olas A1–A4) → Etapa B (salud proactiva, Ola B1-Amend) → Etapa C (humanización, Ola C1-Amend) → **La Etapa D se integra en la Fase 10 de Tratamiento Completo** (logotipo, página de inicio, manual, pulido de la CLI en línea). No se ha enviado ninguna ola de la colmena de la Etapa D. El registro completo está disponible en [`CHANGELOG.md`](CHANGELOG.md) y en los informes `swarm-stage-*-*.md` en la raíz del repositorio.

## Requisitos previos

- Node.js 20+ (obligatorio mediante `engines.node` en `package.json`)
- npm

## Modelo de confianza

`db-cluster` se ejecuta **localmente**. Lee y escribe en un directorio `.db-cluster/` en el
directorio de trabajo al que lo dirija y lee los artefactos que pasa a `ingest`.
**No hay conexiones de red salientes** de forma predeterminada y **no hay telemetría**. La única
conexión de salida opcional es a un host de Postgres si establece
`DB_CLUSTER_POSTGRES_URL` (y se respeta `DB_CLUSTER_POSTGRES_SSL`).

Las herramientas del servidor MCP solo leen y escriben en los almacenes locales; nunca acceden a la
red, y las respuestas estructuradas `AiErrorEnvelope` nunca filtran trazas de pila ni
rutas del sistema de archivos. Los comandos de la CLI destructivos (`restaurar`, `reconstruir índice`,
`compensar`, `copia de seguridad --force-overwrite`) requieren una opción `--yes` explícita y
una confirmación interactiva en la terminal.

El modelo de amenazas completo, que incluye los datos que se tocan, los datos que NO se tocan, los permisos requeridos,
la postura de cada componente y los residuos rastreados, se encuentra en
[`SECURITY.md`](SECURITY.md).

## Documentación

Consulte [`docs/README.md`](docs/README.md) para obtener el mapa de documentación completo (Comience aquí /
Referencia / Historial de la fase de desarrollo). Destacados:

- [Guía de inicio rápido](docs/quickstart.md) — Una forma rápida de empezar (5 minutos).
- [Manual](docs/handbook.md) — Guía para operadores y desarrolladores.
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — Referencias básicas.
- [Políticas y eliminación de datos](docs/policy-and-redaction.md) — Principales características: capacidad, política, TrustZone.
- [Operaciones](docs/operations.md) — Funciones: diagnóstico, verificación, reconstrucción, copia de seguridad, restauración.
- [Manuales de operación](docs/runbooks/README.md) — Un manual por cada tipo de error.
- [Preparación para el lanzamiento](docs/release-readiness.md) — Proceso de lanzamiento y patrones de errores conocidos.

## Licencia

MIT
