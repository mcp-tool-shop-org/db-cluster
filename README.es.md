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
  <a href="https://github.com/mcp-tool-shop-org/db-cluster/pkgs/container/db-cluster"><img src="https://img.shields.io/badge/ghcr.io-db--cluster-2496ED?logo=docker" alt="Docker image on GHCR" /></a>
</p>

**Clúster de base de datos federada nativo de IA.** Almacenes de datos especializados que funcionan como un sustrato gobernado único: errores tipados, códigos de salida estructurados, recibos de mutación, MCP + SDK + interfaces CLI.

"Federada" significa almacenes de datos especializados que pueden ejecutarse en diferentes entornos; el entorno de Postgres se aplica actualmente solo al **almacén canónico**: los almacenes de artefactos, índices y registros se ejecutan en los entornos locales/SQLite.

## ¿Para quién es esto?

- **Agentes de IA** que necesitan una recuperación fiable, envolventes de errores estructurados y un ciclo de vida de mutación que no les permita corromper el estado de forma silenciosa.
- **Operadores** que ejecutan almacenes de gráficos y procedencia y que desean códigos de salida tipados, diagnósticos de verificación, manuales de procedimientos y copias de seguridad/restauraciones seguras.
- **Desarrolladores** que crean aplicaciones basadas en clústeres y que desean una API pública deliberada, pruebas de instalación inicial y JSDoc + ejemplos por método.
- **Usuarios de paneles de control** que auditan la información del clúster: propiedad del almacén, linaje de procedencia, vista previa de comandos, vista de ocultación.

## ¿Por qué usar db-cluster?

- **Errores tipados con `remediationHint`** (sugerencia de remediación): cada subclase de `ClusterError` responde a QUÉ HACER, no solo a QUÉ falló (códigos de salida de la CLI 65/70/77/78 asignados a códigos de error tipados).
- **Envolventes de errores de IA**: esquema `{code, message, retryable, remediation_hint, context, next_valid_actions}`; los agentes de IA pueden ramificarse en función de `code` y `retryable` en lugar de analizar texto.
- **Recibos en cada mutación**: direccionables por contenido; grafo de procedencia; contrato de reconstrucción a partir de la información del almacén de índices.
- **Servidor MCP con anotaciones de seguridad**: las herramientas de solo lectura / por etapas / aprobación / escritura tienen cada una indicadores `readOnlyHint` / `destructiveHint` legibles por máquina. El servidor tiene como valor predeterminado la zona de confianza `ai-facing` (ocultación ACTIVADA), y las herramientas de escritura de MCP se niegan a confirmar hasta que el comando esté `aprobado`.
- **Política aplicada por defecto**: la fábrica de raíz del paquete `createSafeCluster()` devuelve un controlador con políticas aplicadas (un `PolicyEnforcedKernel` + operaciones de solo lectura, sin modificadores de almacén sin procesar). Los almacenes sin procesar y sin políticas son accesibles solo a través de la vía de escape explícita `@mcptoolshop/db-cluster/unsafe`.

## Guía de inicio rápido (3 pasos)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

O instale globalmente y use los archivos binarios `db-cluster` y `db-cluster-mcp` directamente:

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

O ejecute a través de Docker (no se requiere la instalación de Node):

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

Ruta completa óptima: [`docs/quickstart.md`](docs/quickstart.md) (5 minutos).

## ¿Qué es esto?

Un clúster de base de datos federada donde:

- **Almacén canónico**: entidades, ID, registros de estado estables
- **Almacén de artefactos**: archivos sin procesar, documentos, texto fuente, salidas generadas
- **Almacén de índices**: capacidad de descubrimiento, búsqueda de texto completo (clasificada), búsqueda de metadatos
- **Registro de eventos/procedencia**: acciones, enlaces, mutaciones, recibos, linaje

El núcleo enruta. El índice descubre. El clúster posee la información.

## ¿Qué no es esto?

- Un asistente de base de datos de IA
- Un índice sobre muchos almacenes
- Middleware de gobernanza
- Una base de datos vectorial con complementos
- Una capa de memoria de agente

## Leyes de la arquitectura

1. Cada hecho tiene un almacén propietario.
2. Los índices son derivados: se pueden eliminar y reconstruir a partir de los almacenes propietarios.
3. La IA nunca modifica directamente el estado sin procesar.
4. Cada respuesta se remonta a la fuente de información.
5. Cada mutación cruza una frontera de comando tipada.
6. La información de los artefactos es inmutable por defecto: las correcciones crean versiones, no sobrescriben.
7. El núcleo enruta; el clúster posee.

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

Consulte [`docs/cli.md`](docs/cli.md) para obtener la referencia completa de la CLI (incluida la tabla de códigos de salida tipados).

## Requisitos previos

- Node.js 20+ (aplicado a través de `engines.node` en `package.json`)
- npm

## Modelo de confianza

db-cluster se ejecuta **localmente**. Lee y escribe un directorio `.db-cluster/` en el
directorio de trabajo al que lo apunte y lee los artefactos que le pase a `ingest`.
Por defecto, **no hay salida de red** y **no hay telemetría**. La única
conexión saliente opcional es a un host de Postgres si establece
`DB_CLUSTER_POSTGRES_URL`. **db-cluster no configura SSL/TLS para esa
conexión en v1.0.0**: el transporte es texto sin formato a menos que su cadena de conexión lo imponga (por ejemplo, `sslmode=require`, que el controlador `pg` respeta), un proxy de terminación TLS o una red privada. La configuración de TLS administrada por el controlador se
planifica para una versión futura.

Las herramientas del servidor MCP leen y escriben solo en los almacenes locales; nunca llegan a la
red, y las respuestas estructuradas `AiErrorEnvelope` nunca filtran rastreos de pila ni
rutas de archivos. **El servidor MCP tiene como valor predeterminado la zona de confianza `ai-facing` con
ocultación ACTIVADA**: el contenido de los artefactos y los atributos de entidad confidenciales se eliminan
en la frontera por defecto, y ninguna herramienta de MCP devuelve bytes de artefacto sin procesar. Un operador
que necesita la postura privilegiada (`internal` / `cluster-admin`) debe optar explícitamente
a través de una marca de entorno (provisionalmente `DB_CLUSTER_MCP_ALLOW_PRIVILEGED`;
consulte [`docs/mcp.md`](docs/mcp.md)). **Las herramientas de escritura de MCP aplican la aprobación**:
`cluster_commit_mutation` y `cluster_compensate_mutation` se niegan a escribir
a menos que el comando esté en estado `aprobado`; el llamador primero debe llamar
a `cluster_approve_mutation`, y el rechazo es un `AiErrorEnvelope` estructurado,
no una escritura parcial. (Los llamadores de SDK en proceso de confianza no se ven afectados; esta puerta de enlace
es solo para la superficie de MCP). Los comandos de CLI destructivos (`restore`, `rebuild index`,
`compensate`, `backup --force-overwrite`) requieren una marca `--yes` explícita más
una confirmación interactiva en TTY.

El modelo de amenazas completo: datos tocados, datos NO tocados, permisos requeridos,
postura por superficie y residuos rastreados, se encuentra en
[`SECURITY.md`](SECURITY.md).

## Documentación

Consulte [`docs/README.md`](docs/README.md) para ver el mapa completo de la documentación (comience aquí / referencia / historial de la fase de desarrollo). Aspectos destacados:

- [Guía de inicio rápido](docs/quickstart.md): la guía esencial en 5 minutos.
- [Manual](docs/handbook.md): guía completa para operadores y desarrolladores.
- [Arquitectura](docs/architecture.md): modelo de verdad federada y las siete leyes de la arquitectura.
- [Contratos de almacenamiento](docs/store-contracts.md): qué posee y garantiza cada uno de los cuatro almacenes.
- [Ley de mutación](docs/mutation-law.md) / [Gráficos de procedencia](docs/provenance-graphs.md): ciclo de vida de escritura segura y seguimiento del linaje.
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md): referencias.
- [Política y ocultación de datos](docs/policy-and-redaction.md): Principal, Capacidad, Política, TrustZone.
- [Operaciones](docs/operations.md): diagnóstico, verificación, reconstrucción, copia de seguridad, restauración.
- [Manuales de operación](docs/runbooks/README.md): un manual por cada clase de error.
- [Preparación para la publicación](docs/release-readiness.md): flujo de publicación y patrones de fallos conocidos.

## Licencia

MIT
