<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.md">English</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**Cluster di database federato progettato per l'IA.** Archivi di dati specializzati che operano come un'unica entità gestita: errori tipizzati, codici di uscita strutturati, ricevute di modifica, MCP + SDK + interfacce CLI.

"Federato" significa archivi di dati specializzati che possono essere eseguiti su diversi backend; attualmente, il backend Postgres si applica solo all'**archivio principale** (canone): gli archivi di artefatti, indici e registri vengono eseguiti sui backend locali/SQLite.

## A chi è destinato

- **Agenti IA** che necessitano di un recupero affidabile, strutture di errore strutturate e un ciclo di vita delle modifiche che impedisca la corruzione silenziosa dello stato.
- **Operatori** che gestiscono archivi di grafi e provenienza e desiderano codici di uscita tipizzati, strumenti di diagnostica per la verifica, manuali operativi e backup/ripristino sicuri.
- **Sviluppatori** che creano applicazioni basate su cluster e desiderano un'API pubblica ben definita, test di installazione iniziale e documentazione JSDoc + esempi per ogni metodo.
- **Utenti di dashboard** che eseguono audit dei dati del cluster: proprietà dell'archivio, provenienza, anteprima dei comandi, visualizzazione con rimozione di informazioni sensibili.

## Perché utilizzare db-cluster

- **Errori tipizzati con `remediationHint`**: ogni sottoclasse di `ClusterError` indica COSA FARE, non solo COSA è fallito (i codici di uscita CLI 65/70/77/78 sono mappati ai codici di errore tipizzati).
- **Strutture di errore IA**: schema `{code, message, retryable, remediation_hint, context, next_valid_actions}`; gli agenti IA possono ramificare in base a `code` e `retryable` anziché analizzare il testo.
- **Ricevute per ogni modifica**: indirizzabili in base al contenuto; grafico di provenienza; contratto di ricostruzione dai dati dell'archivio degli indici.
- **Server MCP con annotazioni di sicurezza**: gli strumenti di sola lettura, in fase di test, di approvazione e di scrittura includono tutti flag `readOnlyHint` / `destructiveHint` leggibili dalla macchina. Il server utilizza per impostazione predefinita la zona di fiducia `ai-facing` (rimozione di informazioni sensibili ATTIVA) e gli strumenti di scrittura MCP rifiutano di eseguire il commit finché il comando non è `approvato`.
- **Politiche applicate per impostazione predefinita**: la factory root del pacchetto `createSafeCluster()` restituisce un gestore con politiche applicate (un `PolicyEnforcedKernel` + operazioni di sola lettura, nessun modificatore di archivio non protetto). Gli archivi non protetti sono accessibili solo tramite la via di fuga esplicita `@mcptoolshop/db-cluster/unsafe`.

## Guida rapida (3 passaggi)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

Oppure, installare a livello globale e utilizzare direttamente i binari `db-cluster` e `db-cluster-mcp`:

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

Oppure, eseguire tramite Docker (non è richiesta l'installazione di Node):

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

Percorso completo ottimale: [`docs/quickstart.md`](docs/quickstart.md) (5 minuti).

## Cos'è

Un cluster di database federato in cui:

- **Archivio principale**: entità, ID, record di stato stabili
- **Archivio di artefatti**: file, documenti, testo di origine, output generati
- **Archivio di indici**: individuabilità, ricerca completa (ordinata), ricerca di metadati
- **Registro eventi/provenienza**: azioni, collegamenti, modifiche, ricevute, provenienza

Il kernel instrada. L'indice individua. Il cluster possiede i dati.

## Cos'è che non è

- Un assistente di database IA
- Un indice su più archivi
- Middleware di governance
- Un database vettoriale con plugin
- Un livello di memoria per agenti

## Leggi sull'architettura

1. Ogni dato ha un archivio proprietario
2. Gli indici sono derivati: possono essere eliminati e ricostruiti dagli archivi proprietari
3. L'IA non modifica mai direttamente lo stato originale
4. Ogni risposta traccia la fonte dei dati
5. Ogni modifica attraversa un confine di comando tipizzato
6. I dati degli artefatti sono immutabili per impostazione predefinita: le correzioni creano versioni, non sovrascrivono
7. Il kernel instrada; il cluster possiede

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

Consultare [`docs/cli.md`](docs/cli.md) per il riferimento completo della CLI (inclusa la tabella dei codici di uscita degli errori tipizzati).

## Prerequisiti

- Node.js 20+ (applicato tramite `engines.node` in `package.json`)
- npm

## Modello di fiducia

db-cluster viene eseguito **localmente**. Legge e scrive una directory `.db-cluster/` nella directory di lavoro a cui lo si indirizza e legge gli artefatti che vengono passati a `ingest`. Per impostazione predefinita, **non c'è traffico di rete in uscita** e **non c'è telemetria**. L'unica connessione in uscita facoltativa è verso un host Postgres se si imposta `DB_CLUSTER_POSTGRES_URL`. **db-cluster non configura SSL/TLS per tale connessione nella versione 1.0.0**: il trasporto è in testo semplice a meno che la stringa di connessione non lo applichi (ad esempio, `sslmode=require`, che il driver `pg` rispetta), un proxy che termina TLS o una rete privata. La configurazione TLS gestita dal driver è prevista per una versione futura.

Gli strumenti del server MCP leggono e scrivono solo gli archivi locali: non raggiungono mai la rete e le risposte strutturate `AiErrorEnvelope` non divulgano mai tracce dello stack o percorsi del file system. **Il server MCP utilizza per impostazione predefinita la zona di fiducia `ai-facing` con la rimozione di informazioni sensibili ATTIVA**: il contenuto degli artefatti e gli attributi sensibili delle entità vengono rimossi al limite per impostazione predefinita e nessuno strumento MCP restituisce byte di artefatti non elaborati. Un operatore che necessita della postura privilegiata (`internal` / `cluster-admin`) deve esplicitamente accettare tramite un flag di ambiente (provvisoriamente `DB_CLUSTER_MCP_ALLOW_PRIVILEGED`; vedere [`docs/mcp.md`](docs/mcp.md)). **Gli strumenti di scrittura MCP applicano l'approvazione**: `cluster_commit_mutation` e `cluster_compensate_mutation` rifiutano di scrivere a meno che il comando non sia nello stato `approvato`: il chiamante deve prima chiamare `cluster_approve_mutation` e il rifiuto è una struttura `AiErrorEnvelope`, non una scrittura parziale. (I chiamanti SDK attendibili in-process non sono interessati: questo gateway è solo per la superficie MCP). I comandi CLI distruttivi (`restore`, `rebuild index`, `compensate`, `backup --force-overwrite`) richiedono un flag esplicito `--yes` più una conferma interattiva su TTY.

Il modello di minaccia completo: dati toccati, dati NON toccati, autorizzazioni richieste, postura per ogni interfaccia e residui tracciati, è disponibile in [`SECURITY.md`](SECURITY.md).

## Documentazione

Per la mappa completa della documentazione, consultare il file [`docs/README.md`](docs/README.md) (iniziare da qui / riferimento / cronologia della fase di sviluppo). Punti salienti:

- [Guida rapida](docs/quickstart.md) — percorso ottimale in 5 minuti
- [Manuale](docs/handbook.md) — guida completa per operatori e sviluppatori
- [Architettura](docs/architecture.md) — modello federato e le sette leggi dell'architettura
- [Contratti di archiviazione](docs/store-contracts.md) — cosa possiede e garantisce ciascuno dei quattro sistemi di archiviazione
- [Legge sulla modifica](docs/mutation-law.md) / [Grafici di provenienza](docs/provenance-graphs.md) — ciclo di vita della scrittura sicura e tracciamento della provenienza
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — riferimenti generali
- [Politiche e mascheramento](docs/policy-and-redaction.md) — Principale, Capacità, Politica, TrustZone
- [Operazioni](docs/operations.md) — controllo, verifica, ricostruzione, backup, ripristino
- [Manuali operativi](docs/runbooks/README.md) — un manuale per ogni classe di errore
- [Pronti per il rilascio](docs/release-readiness.md) — flusso di rilascio e modelli di errore noti

## Licenza

MIT
