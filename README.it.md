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

**I database tradizionali presuppongono un chiamante attento e deterministico. Gli agenti di intelligenza artificiale non lo sono.**
Un archivio convenzionale fornisce a un agente errori scritti per gli sviluppatori umani, esegue qualsiasi operazione di scrittura che gli viene fornita nel momento in cui è valida e restituisce tutti i campi a cui la query fa riferimento, in modo che l'agente non possa determinare in modo affidabile cosa fare successivamente, non c'è nulla che impedisca un'iniezione di prompt e i dati sensibili finiscono direttamente nella finestra di contesto. db-cluster è stato progettato partendo da questa incongruenza: archivi specializzati che funzionano come un unico cluster dietro un singolo kernel con applicazione di policy, soddisfacendo le esigenze dell'agente: errori tipizzati che indicano cosa fare successivamente, recupero che restituisce un insieme di prove verificabili, rimozione di informazioni su ogni percorso di lettura e un ciclo di vita di proposta → approvazione → esecuzione che impedisce a un'iniezione di prompt di corrompere silenziosamente l'archivio. Per impostazione predefinita, è locale; quando si aumenta la capacità, si utilizzano Postgres e SQLite tramite CLI, SDK e MCP.

## A chi è destinato

- **Agenti di intelligenza artificiale** che necessitano di un recupero affidabile, strutture di errore strutturate e un ciclo di vita delle modifiche che impedisca loro di corrompere silenziosamente lo stato.
- **Operatori** che gestiscono archivi di grafi e provenienza e desiderano codici di uscita tipizzati, strumenti di diagnostica per la verifica, manuali operativi e backup/ripristino sicuri.
- **Sviluppatori** che creano applicazioni basate su cluster e desiderano un'API pubblica ben definita, test di installazione iniziale e JSDoc + esempi per ogni metodo.
- **Utenti di dashboard** che eseguono audit dei dati del cluster: proprietà dell'archivio, provenienza, anteprima dei comandi, visualizzazione delle informazioni rimosse.

## Perché utilizzare db-cluster

- **Errori tipizzati con `remediationHint`**: ogni sottoclasse di `ClusterError` risponde indicando COSA FARE, non solo COSA è fallito (i codici di uscita CLI 65/70/77/78 sono mappati ai codici di errore tipizzati).
- **Strutture di errore per l'IA**: schema `{code, message, retryable, remediation_hint, context, next_valid_actions}`; gli agenti di intelligenza artificiale possono ramificare in base a `code` e `retryable` anziché analizzare il testo.
- **Ricevute per ogni modifica**: indirizzabili in base al contenuto; grafico di provenienza; contratto di ricostruzione dai dati di origine sull'archivio di indici.
- **Server MCP con annotazioni di sicurezza**: gli strumenti di sola lettura, in fase di preparazione, di approvazione e di scrittura dispongono ciascuno di flag `readOnlyHint` / `destructiveHint` leggibili dalla macchina. Per impostazione predefinita, il server utilizza la zona di fiducia `ai-facing` (rimozione delle informazioni attiva, nessun contenuto non elaborato) e gli strumenti di scrittura MCP rifiutano di eseguire l'operazione fino a quando il comando non viene `approvato`.
- **Applicazione di policy per impostazione predefinita**: la factory root del pacchetto `createSafeCluster()` restituisce un gestore con policy applicate (un `PolicyEnforcedKernel` + operazioni di sola lettura, nessun modificatore di archivio non elaborato). Gli archivi non elaborati e senza policy sono accessibili solo tramite la funzione di escape esplicita `@mcptoolshop/db-cluster/unsafe`.

## Guida rapida (3 passaggi)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

Oppure, installare a livello globale e utilizzare direttamente i binari `db-cluster` e `db-cluster-mcp`.

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

- **Archivio canonico**: entità, ID, record di stato stabili
- **Archivio di artefatti**: file non elaborati, documenti, testo di origine, output generati
- **Archivio di indici**: individuabilità, ricerca completa (ordinata), ricerca di metadati
- **Registro eventi/provenienza**: azioni, collegamenti, modifiche, ricevute, provenienza

Il kernel instrada. L'indice individua. Il cluster possiede la verità.

"Federato" significa che questi archivi possono essere eseguiti su backend diversi: il backend Postgres si applica attualmente solo all'**archivio canonico**: gli archivi di artefatti, indici e registro vengono eseguiti sui backend locali o SQLite.

## Cos'è

- Un assistente di database per l'IA
- Un indice su più archivi
- Middleware di governance
- Un database vettoriale con plugin
- Un livello di memoria per agenti

## Leggi sull'architettura

1. Ogni fatto ha un archivio proprietario
2. Gli indici sono derivati: possono essere eliminati e ricostruiti dagli archivi proprietari
3. L'IA non modifica mai direttamente lo stato non elaborato
4. Ogni risposta può essere fatta risalire alla fonte di verità
5. Ogni modifica supera un confine di comando tipizzato
6. La verità degli artefatti è immutabile per impostazione predefinita: le correzioni creano versioni, non sovrascrivono
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

Consultare [`docs/cli.md`](docs/cli.md) per il riferimento completo della CLI (inclusa la tabella dei codici di uscita tipizzati).

## Prerequisiti

- Node.js 20+ (applicato tramite `engines.node` in `package.json`)
- npm

## Modello di fiducia

db-cluster viene eseguito **localmente**. Legge e scrive una directory `.db-cluster/` nella directory di lavoro a cui lo si indirizza e legge gli artefatti che vengono passati a `ingest`. Per impostazione predefinita, **non c'è traffico di rete in uscita** e **non c'è telemetria**. L'unica connessione in uscita facoltativa è verso un host Postgres se si imposta `DB_CLUSTER_POSTGRES_URL`. **db-cluster non configura SSL/TLS per tale connessione nella versione 1.0.0**: il trasporto è in testo non crittografato a meno che la stringa di connessione non lo applichi (ad esempio, `sslmode=require`, che il driver `pg` rispetta), un proxy che termina la connessione TLS o una rete privata. La configurazione TLS gestita dal driver è prevista per una versione futura.

Gli strumenti server MCP leggono e scrivono solo gli archivi locali; non accedono mai alla rete e le risposte strutturate di tipo `AiErrorEnvelope` non rivelano mai tracce dello stack o percorsi del file system. **Per impostazione predefinita, il server MCP utilizza la zona di fiducia `ai-facing` con la funzione di anonimizzazione attiva:** il contenuto degli artefatti e gli attributi sensibili delle entità vengono rimossi al limite, e nessuno strumento MCP restituisce byte di artefatti non elaborati. Un operatore che necessita dei privilegi (`internal` / `cluster-admin`) deve abilitare esplicitamente questa funzione tramite un flag di ambiente (provvisoriamente `DB_CLUSTER_MCP_ALLOW_PRIVILEGED`; vedere [`docs/mcp.md`](docs/mcp.md)). **Gli strumenti di scrittura MCP richiedono l'approvazione:** `cluster_commit_mutation` e `cluster_compensate_mutation` rifiutano di scrivere a meno che il comando non si trovi nello stato `approved`; il chiamante deve prima chiamare `cluster_approve_mutation`, e il rifiuto è una risposta strutturata di tipo `AiErrorEnvelope`, non una scrittura parziale. (Le chiamate attendibili all'interno del processo SDK non sono interessate; questo controllo si applica solo all'interfaccia MCP). I comandi CLI distruttivi (`restore`, `rebuild index`, `compensate`, `backup --force-overwrite`) richiedono un flag esplicito `--yes` e una conferma interattiva sul terminale.

Il modello completo delle minacce (dati interessati, dati non interessati, autorizzazioni richieste, postura per ogni interfaccia e residui tracciati) è disponibile in [`SECURITY.md`](SECURITY.md).

## Documentazione

Per la mappa completa della documentazione, vedere [`docs/README.md`](docs/README.md) (iniziare da qui / riferimento / cronologia della fase di sviluppo). Punti salienti:

- [Guida rapida](docs/quickstart.md) — percorso ottimale in 5 minuti
- [Manuale](docs/handbook.md) — guida completa per operatori e sviluppatori
- [Architettura](docs/architecture.md) — modello di verità federato e le sette leggi dell'architettura
- [Contratti di archiviazione](docs/store-contracts.md) — cosa possiede e garantisce ciascuno dei quattro archivi
- [Legge sulla modifica](docs/mutation-law.md) / [Grafici di provenienza](docs/provenance-graphs.md) — ciclo di vita della scrittura sicura e tracciamento della provenienza
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — riferimenti alle interfacce
- [Politica e anonimizzazione](docs/policy-and-redaction.md) — Principale, Capacità, Politica, Zona di fiducia
- [Operazioni](docs/operations.md) — controllo, verifica, ricostruzione, backup, ripristino
- [Manuali operativi](docs/runbooks/README.md) — un manuale per ogni classe di errore
- [Prontezza per il rilascio](docs/release-readiness.md) — flusso di rilascio e modelli di errore noti

## Licenza

MIT
