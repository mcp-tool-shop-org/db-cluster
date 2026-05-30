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

**Las bases de datos tradicionales asumen un llamador cuidadoso y determinista. Los agentes de IA no lo son.**
Un almacén convencional proporciona a un agente errores escritos para desarrolladores humanos, confirma cualquier operación que se le indique en el instante en que es válida y devuelve todos los campos a los que afecta la consulta, de modo que el agente no puede determinar de forma fiable qué hacer a continuación, no hay nada que impida una inyección de indicaciones y sus datos, y los secretos terminan directamente en la ventana de contexto. db-cluster se diseñó teniendo en cuenta esta diferencia: almacenes de datos especializados que se ejecutan como un único clúster detrás de un único núcleo con políticas aplicadas, satisfaciendo las necesidades del agente: errores tipados que indican qué hacer a continuación, recuperación que devuelve un conjunto de pruebas citables, eliminación en cada ruta de lectura y un ciclo de vida de propuesta → aprobación → confirmación que evitará que una inyección de indicaciones corrompa silenciosamente su almacén. De forma predeterminada, es local; Postgres y SQLite cuando se amplía, a través de CLI, SDK y MCP.

## ¿Para quién es esto?

- **Agentes de IA** que necesitan una recuperación fiable, estructuras de errores y un ciclo de vida de mutación que evite que corrompan el estado de forma silenciosa.
- **Operadores** que ejecutan almacenes de gráficos y procedencia y que desean códigos de salida tipados, diagnósticos de verificación/detección de errores, libros de procedimientos y copias de seguridad/restauraciones seguras.
- **Desarrolladores** que crean aplicaciones basadas en clústeres y que desean una API pública bien definida, pruebas de instalación inicial y JSDoc + ejemplos por método.
- **Usuarios de paneles de control** que auditan la integridad del clúster: propiedad del almacén, linaje de procedencia, vista previa de comandos, vista de eliminación.

## ¿Por qué usar db-cluster?

- **Errores tipados con `remediationHint`**: cada subclase de `ClusterError` responde a QUÉ HAY QUE HACER, no solo a QUÉ falló (códigos de salida de CLI 65/70/77/78 asignados a códigos de error tipados).
- **Estructuras de errores de IA**: esquema `{code, message, retryable, remediation_hint, context, next_valid_actions}`; los agentes de IA pueden ramificarse en función de `code` y `retryable` en lugar de analizar texto.
- **Comprobantes en cada mutación**: direccionables por contenido; grafo de procedencia; contrato de reconstrucción a partir de la verdad en el almacén de índices.
- **Servidor MCP con anotaciones de seguridad**: las herramientas de solo lectura, por etapas, de aprobación y de escritura tienen cada una indicadores `readOnlyHint` / `destructiveHint` legibles por máquina. El servidor utiliza de forma predeterminada la zona de confianza `ai-facing` (eliminación activada, sin contenido sin procesar), y las herramientas de escritura de MCP se niegan a confirmar hasta que el comando sea `aprobado`.
- **Políticas aplicadas de forma predeterminada**: la fábrica de la raíz del paquete `createSafeCluster()` devuelve un controlador con políticas aplicadas (un `PolicyEnforcedKernel` + operaciones de solo lectura, sin modificadores de almacén sin procesar). Los almacenes sin procesar y sin políticas son accesibles solo a través de la vía de escape explícita `@mcptoolshop/db-cluster/unsafe`.

## Guía de inicio rápido (3 pasos)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

O instálelo globalmente y utilice directamente los comandos `db-cluster` y `db-cluster-mcp`:

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

O ejecútelo a través de Docker (no se requiere la instalación de Node):

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

Ruta completa óptima: [`docs/quickstart.md`](docs/quickstart.md) (5 minutos).

## ¿Qué es esto?

Un clúster de bases de datos federadas en el que:

- **Almacén canónico**: entidades, ID, registros de estado estables
- **Almacén de artefactos**: archivos sin procesar, documentos, texto fuente, resultados generados
- **Almacén de índices**: capacidad de búsqueda, búsqueda de texto completo (clasificada), búsqueda de metadatos
- **Registro de eventos/procedencia**: acciones, vínculos, mutaciones, comprobantes, linaje

El núcleo enruta. El índice descubre. El clúster es el propietario de la verdad.

"Federado" significa que estos almacenes pueden ejecutarse en diferentes backends: el backend de Postgres se aplica actualmente solo al **almacén canónico**: los almacenes de artefactos, índices y registros se ejecutan en los backends locales o SQLite.

## ¿Qué no es esto?

- Un asistente de base de datos de IA
- Un índice sobre muchos almacenes
- Middleware de gobernanza
- Una base de datos vectorial con complementos
- Una capa de memoria del agente

## Leyes de la arquitectura

1. Cada hecho tiene un almacén propietario
2. Los índices son derivados: se pueden eliminar y reconstruir a partir de los almacenes propietarios
3. La IA nunca modifica directamente el estado sin procesar
4. Cada respuesta se remonta a la fuente de la verdad
5. Cada mutación cruza una frontera de comando tipada
6. La verdad del artefacto es inmutable de forma predeterminada: las correcciones crean versiones, no sobrescriben
7. El núcleo enruta; el clúster es el propietario

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

db-cluster se ejecuta **localmente**. Lee y escribe en un directorio `.db-cluster/` en el directorio de trabajo al que lo apunte y lee los artefactos que le pase a `ingest`. No hay **salida de red** de forma predeterminada y **no hay telemetría**. La única conexión saliente opcional es a un host de Postgres si establece `DB_CLUSTER_POSTGRES_URL`. **db-cluster no configura SSL/TLS para esa conexión en la versión 1.0.0**: el transporte es texto sin formato a menos que su cadena de conexión lo aplique (por ejemplo, `sslmode=require`, que el controlador `pg` respeta), un proxy que finalice TLS o una red privada. La configuración de TLS administrada por el controlador se planea para una versión futura.

Las herramientas del servidor MCP solo leen y escriben en los almacenes locales; nunca acceden a la red, y las respuestas estructuradas de `AiErrorEnvelope` nunca revelan rastros de la pila o rutas del sistema de archivos. **De forma predeterminada, el servidor MCP utiliza la zona de confianza `ai-facing` con la función de ocultación activada:** el contenido de los artefactos y los atributos confidenciales de las entidades se eliminan en el límite de forma predeterminada, y ninguna herramienta de MCP devuelve bytes de artefactos sin procesar. Un operador que necesite los permisos especiales (`internal` / `cluster-admin`) debe habilitarlos explícitamente mediante una variable de entorno (provisionalmente `DB_CLUSTER_MCP_ALLOW_PRIVILEGED`; consulte [`docs/mcp.md`](docs/mcp.md)). **Las herramientas de escritura de MCP aplican la aprobación:** `cluster_commit_mutation` y `cluster_compensate_mutation` se niegan a escribir a menos que el comando tenga el estado `approved`; el llamador primero debe llamar a `cluster_approve_mutation`, y el rechazo es una respuesta estructurada de `AiErrorEnvelope`, no una escritura parcial. (Los llamadores de SDK de confianza que se ejecutan en el mismo proceso no se ven afectados; esta restricción solo se aplica a la interfaz de MCP). Los comandos destructivos de la CLI (`restore`, `rebuild index`, `compensate`, `backup --force-overwrite`) requieren una opción explícita `--yes` y una confirmación interactiva en la terminal.

El modelo de amenazas completo (datos a los que se accede, datos a los que NO se accede, permisos requeridos, postura por interfaz y residuos rastreados) se encuentra en [`SECURITY.md`](SECURITY.md).

## Documentación

Consulte [`docs/README.md`](docs/README.md) para obtener el mapa completo de la documentación (Comience aquí / Referencia / Historial de la fase de desarrollo). Aspectos destacados:

- [Guía de inicio rápido](docs/quickstart.md): la ruta óptima en 5 minutos.
- [Manual](docs/handbook.md): guía canónica para operadores y desarrolladores.
- [Arquitectura](docs/architecture.md): modelo de verdad federado y las siete leyes de la arquitectura.
- [Contratos de almacenamiento](docs/store-contracts.md): qué posee y garantiza cada uno de los cuatro almacenes.
- [Ley de mutación](docs/mutation-law.md) / [Gráficos de procedencia](docs/provenance-graphs.md): ciclo de vida de escritura segura y seguimiento del linaje.
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md): referencias de la interfaz.
- [Política y ocultación](docs/policy-and-redaction.md): Principal, Capacidad, Política, Zona de confianza.
- [Operaciones](docs/operations.md): diagnóstico, verificación, reconstrucción, copia de seguridad, restauración.
- [Manuales de operación](docs/runbooks/README.md): un manual por clase de error tipificado.
- [Preparación para la publicación](docs/release-readiness.md): flujo de publicación y patrones de fallos conocidos.

## Licencia

MIT
