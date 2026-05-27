<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.md">English</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/db-cluster/readme.png" alt="db-cluster" width="800" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/db-cluster/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/db-cluster/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@mcptoolshop/db-cluster"><img src="https://img.shields.io/npm/v/@mcptoolshop/db-cluster.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://mcp-tool-shop-org.github.io/db-cluster/handbook/"><img src="https://img.shields.io/badge/handbook-online-blue.svg" alt="Handbook" /></a>
</p>

**Cluster de banco de dados federado nativo para IA.** Armazenamentos especializados que atuam como uma única camada gerenciada, com erros tipados, códigos de saída estruturados, recibos de mutação, APIs, SDKs e interfaces de linha de comando.

## Para quem é isso?

- **Agentes de IA** que precisam de recuperação confiável, envelopes de erro estruturados e um ciclo de vida de mutação que não permita a corrupção silenciosa do estado.
- **Operadores** que utilizam armazenamentos de grafos e rastreabilidade e que desejam códigos de saída tipados, diagnósticos de verificação, manuais de procedimentos, e backups/restaurações seguros.
- **Desenvolvedores** que constroem aplicações baseadas em clusters e que desejam uma API pública bem definida, testes de inicialização, e documentação JSDoc detalhada com exemplos para cada método.
- **Visualizadores de painéis** que auditam a consistência do cluster, incluindo propriedade do armazenamento, rastreabilidade, visualização de comandos e mascaramento de dados.

## Por que usar o db-cluster?

- **Erros tipados com `remediationHint`** — cada subclasse de `ClusterError` indica o que fazer, e não apenas o que falhou (códigos de saída da linha de comando 65/70/77/78 mapeados para códigos de erro tipados).
- **Envelopes de erro para IA** — esquema `{code, message, retryable, remediation_hint, context, next_valid_actions}`; agentes de IA podem ramificar com base em `code` e `retryable` em vez de analisar texto.
- **Recibos para cada mutação** — endereçáveis por conteúdo; grafo de rastreabilidade; contrato de reconstrução a partir da fonte no armazenamento de índice.
- **Servidor MCP com anotações de segurança** — ferramentas de somente leitura / em estágio / aprovação / escrita, cada uma com as flags legíveis por máquina `readOnlyHint` / `destructiveHint`.
- **SDK com aplicação de políticas** — `PolicyEnforcedKernel` é o único caminho; `ClusterKernel` não é exportado intencionalmente.

## Início rápido (3 passos)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

Ou instale globalmente e utilize diretamente os executáveis `db-cluster` e `db-cluster-mcp`:

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

Ou execute via Docker (não é necessário instalar o Node):

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

Caminho completo: [`docs/quickstart.md`](docs/quickstart.md) (5 minutos).

## O que é isso?

Um cluster de banco de dados federado onde:

- **Armazenamento canônico** — entidades, IDs, registros de estado estável.
- **Armazenamento de artefatos** — arquivos brutos, documentos, texto fonte, saídas geradas.
- **Armazenamento de índice** — descoberta, pesquisa de texto completo/vetorial, pesquisa de metadados.
- **Registro de eventos/rastreabilidade** — ações, links, mutações, recibos, linhagem.

O kernel roteia. O índice descobre. O cluster garante a consistência.

## O que isso não é?

- Um assistente de banco de dados para IA.
- Um índice sobre muitos armazenamentos.
- Middleware de governança.
- Um banco de dados vetorial com plugins.
- Uma camada de memória para agentes.

## Princípios de arquitetura

1. Cada fato tem um armazenamento proprietário.
2. Índices são derivados — podem ser excluídos e reconstruídos a partir dos armazenamentos proprietários.
3. A IA nunca muta o estado bruto diretamente.
4. Cada resposta rastreia a fonte da consistência.
5. Cada mutação atravessa uma fronteira de comando tipada.
6. A consistência dos artefatos é imutável por padrão — correções criam versões, não sobrescrevem.
7. O kernel roteia; o cluster garante a consistência.

## Linha de comando (CLI)

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

Consulte [`docs/cli.md`](docs/cli.md) para a referência completa da linha de comando (incluindo a tabela de códigos de erro tipados).

## Status

**v1.0.0 — lançamento.** O db-cluster está com segurança aprimorada em todo o ambiente de testes internos, seguindo o protocolo — Fase A (correção, ondas A1–A4), Fase B (saúde proativa, onda B1-Correção) e Fase C (humanização, onda C1-Correção).
**1247+ testes passando** de forma determinística em 83 arquivos, porta de lançamento 9/9 APROVADA, análise de código limpa.

### O que há na v1.0.0?

- **Modelo de veracidade federado** — armazenamentos canônicos, de artefatos e de índices; o kernel gerencia as rotas, o cluster é o proprietário; o índice é derivado.
- **Erros com informações de correção (`remediationHint`) em todos os lugares** — classe base `ClusterError` e subclasses específicas para cada classe; o CLI mapeia para `sysexits.h` (65/70/77/78); `AiErrorEnvelope` em cada limite da IA.
- **Ciclo de vida das mutações** — propor → validar → aprovar → confirmar → (compensar). Cada confirmação gera um recibo com endereço de conteúdo.
- **Servidor MCP** — 16 ferramentas com anotações de segurança (`readOnlyHint` / `destructiveHint` / `requiresApprovalHint`); resultados de erro estruturados, sem rastreamentos brutos.
- **Políticas e redação** — `PolicyEnforcedKernel` é a única entrada de kernel exportada; tipos `Principal`, `Capability`, `Policy`, `TrustZone` e `VisibilityRule`; redação em todos os caminhos de leitura.
- **Interface do operador** — `doctor`, `verify`, `rebuild index`, `backup`, `restore`, `compensate`, `migration-status`. Comandos destrutivos protegidos por `--yes` e confirmação interativa via TTY.
- **Demonstração do painel** — painel React somente para visualização do estado do cluster (`dashboard/`), com `ComponentState<T>` e `StateBoundary` HOC para estados de carregamento, vazio e erro.
- **Porta de lançamento** — 9 etapas aplicadas por `scripts/release-gate.mjs`: build, testes, empacotamento, instalação de teste, verificação de alterações na documentação, exportação de pacotes, completude, verificação de alterações na documentação e completude do JSDoc.

### Resíduos rastreados para v1.x

- `V2-C1-009` — Operações MCP de longa duração (doctor/verify/rebuild/backup/restore) atualmente são apresentadas como ferramentas de execução única; o streaming granular de progresso está documentado, mas não na v1.0.0. Consulte [`docs/release-readiness.md`](docs/release-readiness.md).
- `KERNEL-C-012` — O canal cross-domain `OperatorSignal` é uma extensão arquitetural da v1.1+.
- O teste de mutação Stryker está disponível (`npm run test:mutation`), mas é experimental — não está incluído no processo de lançamento padrão, de acordo com a doutrina do verificador-3 do "dogfood-swarm" da v2.

### Histórico do "dogfood-swarm"

Estágio A (correção, Waves A1–A4) → Estágio B (saúde proativa, Wave B1-Amend) → Estágio C (humanização, Wave C1-Amend) → **Estágio D é incorporado à Fase 10 de Tratamento Completo** (logotipo, página inicial, manual, refinamento da interface de linha de comando). Nenhuma onda do estágio D foi implementada. Rastreamento completo das alterações está disponível em [`CHANGELOG.md`](CHANGELOG.md) e nos relatórios `swarm-stage-*-*.md` na raiz do repositório.

## Pré-requisitos

- Node.js 20+ (imposto via `engines.node` em `package.json`)
- npm

## Modelo de confiança

O `db-cluster` é executado **localmente**. Ele lê e grava um diretório `.db-cluster/` no
diretório de trabalho para o qual você o direciona e lê os artefatos que você passa para `ingest`.
**Não há saída de rede** por padrão e **não há telemetria**. A única
conexão de saída opcional é para um host Postgres, se você definir
`DB_CLUSTER_POSTGRES_URL` (com `DB_CLUSTER_POSTGRES_SSL` sendo respeitado).

As ferramentas do servidor MCP leem e gravam apenas nos armazenamentos locais — elas nunca acessam a
rede, e as respostas estruturadas `AiErrorEnvelope` nunca expõem rastreamentos de pilha ou
caminhos do sistema de arquivos. Os comandos do CLI que causam alterações (`restore`, `rebuild index`,
`compensate`, `backup --force-overwrite`) exigem uma flag `--yes` explícita e
uma confirmação interativa via TTY.

O modelo de ameaças completo — dados acessados, dados NÃO acessados, permissões necessárias,
postura detalhada e resíduos rastreados — está disponível em
[`SECURITY.md`](SECURITY.md).

## Documentação

Consulte [`docs/README.md`](docs/README.md) para o mapa completo da documentação (Comece aqui /
Referência / Histórico da fase de desenvolvimento). Destaques:

- [Guia de início rápido](docs/quickstart.md) — Um guia rápido de 5 minutos.
- [Manual](docs/handbook.md) — Guia completo para operadores e desenvolvedores.
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — Referências básicas.
- [Políticas e edição](docs/policy-and-redaction.md) — Princípio, capacidade, política, TrustZone.
- [Operações](docs/operations.md) — Doctor, verificar, reconstruir, backup, restaurar.
- [Manuais de operação](docs/runbooks/README.md) — Um manual para cada tipo de erro.
- [Preparação para lançamento](docs/release-readiness.md) — Fluxo de lançamento + padrões de falhas conhecidos.

## Licença

MIT
