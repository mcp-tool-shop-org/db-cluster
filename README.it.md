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
</p>

**Cluster di database federato nativo per l'intelligenza artificiale.** Archivi di dati specializzati che funzionano come un'unica piattaforma gestita, con gestione degli errori tipizzati, codici di uscita strutturati, ricevute delle modifiche, API, SDK e interfaccia a riga di comando.

## A chi è rivolto

- **Agenti di intelligenza artificiale** che necessitano di un recupero affidabile, di strutture di errore ben definite e di un ciclo di vita delle modifiche che impedisca la corruzione silenziosa dello stato.
- **Amministratori di sistema** che gestiscono archivi di grafi e di provenienza e che desiderano codici di uscita tipizzati, strumenti di diagnostica e verifica, guide operative e backup/ripristino sicuri.
- **Sviluppatori** che creano applicazioni basate su cluster e che desiderano un'API pubblica ben definita, test di verifica durante l'installazione e documentazione JSDoc dettagliata con esempi per ogni metodo.
- **Utenti delle dashboard** che monitorano l'integrità del cluster, inclusi la proprietà degli archivi, la tracciabilità, l'anteprima dei comandi e la visualizzazione delle informazioni oscurate.

## Perché utilizzare db-cluster

- **Errori tipizzati con suggerimenti per la correzione (`remediationHint`)**: ogni sottoclasse di `ClusterError` indica cosa fare, non solo cosa è fallito (i codici di uscita della CLI 65/70/77/78 sono mappati a codici di errore tipizzati).
- **Strutture di errore per l'intelligenza artificiale**: schema `{code, message, retryable, remediation_hint, context, next_valid_actions}`; gli agenti di intelligenza artificiale possono ramificare in base a `code` e `retryable` invece di analizzare testo.
- **Ricevute per ogni modifica**: indirizzabili per contenuto; grafo di provenienza; contratto di ricostruzione a partire dalla verità nell'archivio degli indici.
- **Server MCP con annotazioni di sicurezza**: gli strumenti di lettura/scrittura, di staging e di approvazione includono flag leggibili dalla macchina `readOnlyHint` e `destructiveHint`.
- **SDK con applicazione di policy**: `PolicyEnforcedKernel` è l'unico percorso disponibile; `ClusterKernel` non è esplicitamente esposto.

## Guida introduttiva (3 passaggi)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

Oppure, installate globalmente e utilizzate direttamente i binari `db-cluster` e `db-cluster-mcp`:

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

Oppure, eseguite tramite Docker (non è necessaria l'installazione di Node):

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

Percorso completo: [`docs/quickstart.md`](docs/quickstart.md) (5 minuti).

## Cos'è

Un cluster di database federato in cui:

- **Archivio canonico**: entità, ID, record di stato stabile.
- **Archivio di artefatti**: file grezzi, documenti, testo sorgente, output generati.
- **Archivio di indici**: funzionalità di ricerca, ricerca full-text/vettoriale, metadati.
- **Registro di eventi/provenienza**: azioni, collegamenti, modifiche, ricevute, tracciabilità.

Il kernel gestisce il routing. L'indice permette la scoperta. Il cluster garantisce l'integrità dei dati.

## Cosa non è

- Un assistente per database basato sull'intelligenza artificiale.
- Un indice su molti archivi.
- Un middleware di governance.
- Un database vettoriale con plugin.
- Uno strato di memoria per agenti.

## Principi architetturali

1. Ogni dato ha un archivio proprietario.
2. Gli indici sono derivati e possono essere eliminati e ricostruiti a partire dagli archivi proprietari.
3. L'intelligenza artificiale non modifica direttamente lo stato grezzo.
4. Ogni risposta è collegata alla fonte di verità.
5. Ogni modifica avviene attraverso un confine di comando tipizzato.
6. La verità degli artefatti è immutabile per impostazione predefinita: le correzioni creano versioni, non sovrascrizioni.
7. Il kernel gestisce il routing; il cluster garantisce l'integrità dei dati.

## Interfaccia a riga di comando (CLI)

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

Consultare [`docs/cli.md`](docs/cli.md) per la documentazione completa della CLI (inclusa la tabella dei codici di uscita tipizzati).

## Stato

**v1.0.0 — Disponibile.** db-cluster è stato sottoposto a test approfonditi in un ambiente di test interno.
Protocollo — Fase A (correttezza, Wave A1–A4), Fase B (monitoraggio proattivo, Wave B1-Amend) e Fase C (miglioramento dell'esperienza utente, Wave C1-Amend).
**1247+ test superati** in modo deterministico in 83 file, release-gate 9/9 PASS, analisi del codice pulita.

### Cosa c'è nella versione 1.0.0

- **Modello di verità federato** — archiviazione canonica, artefatti, indici, registri; il kernel gestisce le rotte, il cluster gestisce le risorse; l'indice è derivato.
- **Errori con informazioni di correzione (`remediationHint`) in ogni punto** — classe base `ClusterError` e sottoclassi specifiche per ogni classe; la CLI mappa alle funzioni `sysexits.h` (65/70/77/78); `AiErrorEnvelope` in ogni confine dell'intelligenza artificiale.
- **Ciclo di vita delle modifiche** — proposta → validazione → approvazione → commit → (compensazione). Ogni commit genera una ricevuta con indirizzo di contenuto.
- **Server MCP** — 16 strumenti con annotazioni di sicurezza (`readOnlyHint` / `destructiveHint` / `requiresApprovalHint`); risultati degli errori strutturati, mai stack di chiamate grezzi.
- **Politiche e mascheramento** — `PolicyEnforcedKernel` è l'unica voce del kernel esposta; tipi `Principal`, `Capability`, `Policy`, `TrustZone`, `VisibilityRule`; mascheramento in ogni percorso di lettura.
- **Interfaccia utente** — `doctor`, `verify`, `ricostruisci indice`, `backup`, `restore`, `compensate`, `migration-status`. I comandi distruttivi richiedono il flag `--yes` e una conferma interattiva tramite TTY.
- **Demo del pannello di controllo** — pannello React solo in lettura per la coerenza del cluster (`dashboard/`), con `ComponentState<T>` e `StateBoundary` HOC per gli stati di caricamento/vuoto/errore.
- **Fase di rilascio** — 9 fasi applicate da `scripts/release-gate.mjs`: build, test, impacchettamento, installazione di test, controllo della documentazione, esportazione dei pacchetti, completezza, controllo della documentazione, completezza della documentazione JSDoc.

### Residui tracciati per la versione 1.x

- `V2-C1-009` — Le operazioni MCP di lunga durata (doctor/verify/rebuild/backup/restore) attualmente sono implementate come strumenti singoli; lo streaming dettagliato dei progressi è documentato ma non è presente nella versione 1.0.0. Consultare [`docs/release-readiness.md`](docs/release-readiness.md).
- `KERNEL-C-012` — Il canale `OperatorSignal` cross-domain è un'estensione architetturale della versione 1.1+.
- Il test di mutazione con Stryker è disponibile (`npm run test:mutation`) ma è sperimentale e non fa parte della fase di rilascio standard, secondo la dottrina del verifier-3 del "dogfood-swarm" della versione 2.

### Cronologia del "dogfood-swarm"

Fase A (correttezza, Wave A1–A4) → Fase B (salute proattiva, Wave B1-Amend) → Fase C (umanizzazione, Wave C1-Amend) → **Fase D integrata nella Fase 10 di trattamento completo** (logo, pagina di destinazione, manuale, rifinitura dei colori della CLI). Nessuna wave del "dogfood-swarm" della Fase D è stata distribuita. L'intero registro delle modifiche è disponibile in [`CHANGELOG.md`](CHANGELOG.md) e nei report `swarm-stage-*-*.md` nella directory principale del repository.

## Prerequisiti

- Node.js 20+ (imposto tramite `engines.node` in `package.json`)
- npm

## Modello di sicurezza

Il database del cluster viene eseguito **localmente**. Legge e scrive in una directory `.db-cluster/` nella
directory di lavoro a cui lo si indica e legge gli artefatti che si passano a `ingest`.
**Non ci sono connessioni in uscita** per impostazione predefinita e **non ci sono dati di telemetria**. L'unica
connessione in uscita opzionale è a un server Postgres se si imposta
`DB_CLUSTER_POSTGRES_URL` (con rispetto di `DB_CLUSTER_POSTGRES_SSL`).

Gli strumenti del server MCP leggono e scrivono solo nei repository locali; non raggiungono mai
la rete e le risposte strutturate `AiErrorEnvelope` non espongono mai stack di chiamate o
percorsi del file system. I comandi della CLI distruttivi (`restore`, `ricostruisci indice`,
`compensate`, `backup --force-overwrite`) richiedono un flag `--yes` esplicito e
una conferma interattiva tramite TTY.

L'intero modello di minacce — dati elaborati, dati NON elaborati, autorizzazioni richieste,
stato dettagliato per ogni componente e residui tracciati — è disponibile in
[`SECURITY.md`](SECURITY.md).

## Documentazione

Consultare [`docs/README.md`](docs/README.md) per la mappa completa della documentazione (Iniziare qui /
Riferimento / Cronologia della fase di sviluppo). Punti salienti:

- [Guida introduttiva](docs/quickstart.md) — Guida rapida per iniziare (5 minuti)
- [Manuale](docs/handbook.md) — Guida per operatori e sviluppatori
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — Riferimenti di base
- [Politiche e mascheramento](docs/policy-and-redaction.md) — Principale, capacità, politiche, TrustZone
- [Operazioni](docs/operations.md) — Diagnostica, verifica, ricostruzione, backup, ripristino
- [Manuali operativi](docs/runbooks/README.md) — Un manuale operativo per ogni classe di errore
- [Preparazione al rilascio](docs/release-readiness.md) — Flusso di rilascio e modelli di errori noti

## Licenza

MIT
