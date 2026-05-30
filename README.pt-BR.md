<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.md">English</a>
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

**Cluster de banco de dados federado nativo de IA.** Armazenamentos de dados especializados que funcionam como um único substrato governado — erros tipados, códigos de saída estruturados, recibos de mutação, MCP + SDK + interfaces CLI.

"Federado" significa armazenamentos de dados especializados que podem ser executados em diferentes backends; o backend Postgres atualmente se aplica apenas ao **armazenamento canônico** — os armazenamentos de artefatos, índices e registros são executados nos backends locais/SQLite.

## Para quem é isso?

- **Agentes de IA** que precisam de recuperação confiável, envelopes de erro estruturados e um ciclo de vida de mutação que não permita a corrupção silenciosa do estado.
- **Operadores** que executam armazenamentos de gráficos e linhagens e desejam códigos de saída tipados, diagnósticos de verificação/correção, manuais de procedimentos e backups/restaurações seguros.
- **Desenvolvedores** que criam aplicativos com suporte de cluster e desejam uma API pública bem definida, testes de instalação e verificação e JSDoc + exemplos por método.
- **Visualizadores de painel** que auditam os dados do cluster — propriedade do armazenamento, linhagem, visualização de comandos, visualização de redação.

## Por que usar o db-cluster?

- **Erros tipados com `remediationHint`** — cada subclasse de `ClusterError` responde ao QUE FAZER, e não apenas ao QUE falhou (códigos de saída da CLI 65/70/77/78 mapeados para códigos de erro tipados).
- **Envelopes de erro de IA** — esquema `{code, message, retryable, remediation_hint, context, next_valid_actions}`; os agentes de IA podem ramificar com base em `code` e `retryable` em vez de analisar texto.
- **Recibos em cada mutação** — endereçáveis por conteúdo; grafo de linhagem; contrato de reconstrução a partir dos dados no armazenamento de índice.
- **Servidor MCP com anotações de segurança** — as ferramentas somente leitura / em fase de teste / de aprovação / de gravação carregam flags legíveis por máquina `readOnlyHint` / `destructiveHint`. O servidor assume por padrão a zona de confiança `ai-facing` (redação ATIVADA), e as ferramentas de gravação do MCP se recusam a confirmar até que o comando seja `aprovado`.
- **Política aplicada por padrão** — a fábrica raiz do pacote `createSafeCluster()` retorna um manipulador com política aplicada (um `PolicyEnforcedKernel` + operações somente leitura, sem modificadores de armazenamento brutos). Os armazenamentos brutos e não protegidos são acessíveis apenas por meio da saída explícita `unsafe` em `@mcptoolshop/db-cluster`.

## Guia rápido (3 etapas)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

Ou instale globalmente e use os executáveis `db-cluster` e `db-cluster-mcp` diretamente:

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

Ou execute via Docker (não é necessária a instalação do Node):

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

Caminho completo ideal: [`docs/quickstart.md`](docs/quickstart.md) (5 minutos).

## O que é isso?

Um cluster de banco de dados federado onde:

- **Armazenamento canônico** — entidades, IDs, registros de estado estáveis
- **Armazenamento de artefatos** — arquivos brutos, documentos, texto de origem, saídas geradas
- **Armazenamento de índice** — capacidade de descoberta, pesquisa de texto completo (classificada), pesquisa de metadados
- **Registro de eventos/linhagem** — ações, links, mutações, recibos, linhagem

O kernel roteia. O índice descobre. O cluster detém os dados.

## O que isso não é

- Um assistente de banco de dados de IA
- Um índice sobre vários armazenamentos
- Middleware de governança
- Um banco de dados vetorial com plugins
- Uma camada de memória de agente

## Leis de arquitetura

1. Cada fato tem um armazenamento proprietário
2. Os índices são derivados — podem ser excluídos e reconstruídos a partir dos armazenamentos proprietários
3. A IA nunca modifica o estado bruto diretamente
4. Cada resposta rastreia a fonte dos dados
5. Cada mutação atravessa uma fronteira de comando tipada
6. Os dados de artefato são imutáveis por padrão — as correções criam versões, não sobrescrevem
7. O kernel roteia; o cluster detém

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

Consulte [`docs/cli.md`](docs/cli.md) para obter a referência completa da CLI (incluindo a tabela de códigos de saída de erro tipados).

## Pré-requisitos

- Node.js 20+ (aplicado por meio de `engines.node` em `package.json`)
- npm

## Modelo de confiança

O db-cluster é executado **localmente**. Ele lê e grava um diretório `.db-cluster/` no
diretório de trabalho que você especifica e lê os artefatos que você passa para `ingest`.
Não há **saída de rede** por padrão e **nenhuma telemetria**. A única
conexão de saída opcional é para um host Postgres, se você definir
`DB_CLUSTER_POSTGRES_URL`. **O db-cluster não configura SSL/TLS para essa
conexão na versão 1.0.0** — o transporte é texto simples, a menos que sua string de conexão
o force (por exemplo, `sslmode=require`, que o driver `pg` respeita), um
proxy de terminação TLS ou uma rede privada. A configuração de TLS gerenciada pelo driver é
planejada para uma versão futura.

As ferramentas do servidor MCP leem e gravam apenas os armazenamentos locais — elas nunca alcançam a
rede, e as respostas estruturadas `AiErrorEnvelope` nunca vazam rastreamentos de pilha ou
caminhos do sistema de arquivos. **O servidor MCP assume por padrão a zona de confiança `ai-facing` com
redação ATIVADA:** o conteúdo do artefato e os atributos de entidade confidenciais são removidos
na fronteira por padrão, e nenhuma ferramenta MCP retorna bytes de artefato brutos. Um operador
que precisa da postura privilegiada (`internal` / `cluster-admin`) deve optar explicitamente
por meio de uma flag de ambiente (provisoriamente `DB_CLUSTER_MCP_ALLOW_PRIVILEGED`;
consulte [`docs/mcp.md`](docs/mcp.md)). **As ferramentas de gravação do MCP aplicam a aprovação:**
`cluster_commit_mutation` e `cluster_compensate_mutation` se recusam a gravar
a menos que o comando esteja no status `aprovado` — o chamador deve primeiro chamar
`cluster_approve_mutation`, e a recusa é um `AiErrorEnvelope` estruturado,
e não uma gravação parcial. (Os chamadores de SDK confiáveis no processo não são afetados — este portão
é apenas na superfície do MCP.) Os comandos da CLI destrutivos (`restore`, `rebuild index`,
`compensate`, `backup --force-overwrite`) exigem uma flag explícita `--yes` mais
uma confirmação interativa no TTY.

O modelo de ameaças completo — dados acessados, dados NÃO acessados, permissões necessárias,
postura por superfície e resíduos rastreados — está em
[`SECURITY.md`](SECURITY.md).

## Documentação

Consulte [`docs/README.md`](docs/README.md) para obter o mapa completo da documentação (Comece aqui / Referência / Histórico da fase de desenvolvimento). Destaques:

- [Guia de início rápido](docs/quickstart.md) — guia rápida de 5 minutos
- [Manual](docs/handbook.md) — guia do operador e do desenvolvedor
- [Arquitetura](docs/architecture.md) — modelo de verdade federada + as sete leis da arquitetura
- [Contratos de armazenamento](docs/store-contracts.md) — o que cada um dos quatro armazenamentos possui e garante
- [Lei de mutação](docs/mutation-law.md) / [Gráficos de proveniência](docs/provenance-graphs.md) — ciclo de vida de escrita segura e rastreamento da linhagem
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — referências
- [Política e redação](docs/policy-and-redaction.md) — Principal, Capacidade, Política, TrustZone
- [Operações](docs/operations.md) — diagnóstico, verificação, reconstrução, cópia de segurança, restauração
- [Manuais do operador](docs/runbooks/README.md) — um manual por classe de erro
- [Preparação para lançamento](docs/release-readiness.md) — fluxo de lançamento + padrões de falha conhecidos

## Licença

MIT
