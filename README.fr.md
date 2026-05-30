<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.md">English</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**Cluster de base de données fédérée conçu pour l’IA.** Ensemble de référentiels de données spécialisés fonctionnant comme un substrat unifié : erreurs typées, codes de sortie structurés, accusés de réception de mutations, MCP + SDK + interfaces CLI.

« Fédéré » signifie un ensemble de référentiels de données spécialisés qui peuvent fonctionner sur différents supports ; le support Postgres s’applique actuellement uniquement au **référentiel canonique** : les référentiels d’artefacts, d’index et de registre fonctionnent sur les supports locaux/SQLite.

## À qui s’adresse ceci ?

- **Agents d’IA** qui ont besoin d’une récupération fiable, d’enveloppes d’erreurs structurées et d’un cycle de vie de mutation qui ne leur permettra pas de corrompre silencieusement les données.
- **Opérateurs** gérant des référentiels de graphes et de provenance qui souhaitent des codes de sortie typés, des diagnostics de vérification/correction, des guides d’exécution et une sauvegarde/restauration sécurisée.
- **Développeurs** créant des applications basées sur des clusters qui souhaitent une API publique délibérée, des tests de démarrage, et des JSDoc + exemples par méthode.
- **Utilisateurs de tableaux de bord** effectuant des audits sur les données du cluster : propriété du référentiel, lignée de provenance, aperçu des commandes, affichage des données expurgées.

## Pourquoi utiliser db-cluster ?

- **Erreurs typées avec `remediationHint`** : chaque sous-classe de `ClusterError` répond à la question « QUE FAIRE », et non pas seulement « QUOI a échoué » (codes de sortie CLI 65/70/77/78 mappés aux codes d’erreur typés).
- **Enveloppes d’erreurs d’IA** : schéma `{code, message, retryable, remediation_hint, context, next_valid_actions}` ; les agents d’IA peuvent se ramifier en fonction de `code` et de `retryable` au lieu d’analyser du texte.
- **Accusés de réception pour chaque mutation** : adressables par contenu ; graphe de provenance ; contrat de reconstruction à partir des données dans le référentiel d’index.
- **Serveur MCP avec annotations de sécurité** : les outils en lecture seule / en mode de test / d’approbation / d’écriture sont dotés de drapeaux `readOnlyHint` / `destructiveHint` lisibles par machine. Par défaut, le serveur utilise la zone de confiance `ai-facing` (expurgation activée), et les outils d’écriture MCP refusent de valider la commande tant qu’elle n’est pas `approuvée`.
- **Politique appliquée par défaut** : la fabrique de la racine du package `createSafeCluster()` renvoie un gestionnaire avec une politique appliquée (un `PolicyEnforcedKernel` + opérations en lecture seule, pas de modificateurs de référentiel bruts). Les référentiels bruts et non soumis à une politique ne sont accessibles que via la porte de sortie explicite `@mcptoolshop/db-cluster/unsafe`.

## Démarrage rapide (3 étapes)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

Ou installez-le globalement et utilisez directement les exécutables `db-cluster` et `db-cluster-mcp` :

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

Ou exécutez-le via Docker (aucune installation de Node requise) :

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

Chemin complet optimal : [`docs/quickstart.md`](docs/quickstart.md) (5 minutes).

## Ce que c’est

Un cluster de base de données fédérée dans lequel :

- **Référentiel canonique** : entités, ID, enregistrements d’état stables
- **Référentiel d’artefacts** : fichiers bruts, documents, texte source, résultats générés
- **Référentiel d’index** : capacité de découverte, recherche en texte intégral (classée), recherche de métadonnées
- **Registre d’événements/de provenance** : actions, liens, mutations, accusés de réception, lignée

Le noyau effectue le routage. L’index effectue la découverte. Le cluster est propriétaire des données.

## Ce que ce n’est pas

- Un assistant de base de données d’IA
- Un index sur de nombreux référentiels
- Un middleware de gouvernance
- Une base de données vectorielle avec des plug-ins
- Une couche de mémoire d’agent

## Principes d’architecture

1. Chaque fait a un référentiel propriétaire.
2. Les index sont dérivés : ils peuvent être supprimés et reconstruits à partir des référentiels propriétaires.
3. L’IA ne modifie jamais directement les données brutes.
4. Chaque réponse est traçable jusqu’à la source des données.
5. Chaque mutation passe une limite de commande typée.
6. Les données d’artefacts sont immuables par défaut : les corrections créent des versions, et non des remplacements.
7. Le noyau effectue le routage ; le cluster est propriétaire.

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

Consultez [`docs/cli.md`](docs/cli.md) pour obtenir la référence complète de l’interface de ligne de commande (y compris le tableau des codes de sortie d’erreur typés).

## Prérequis

- Node.js 20+ (appliqué via `engines.node` dans `package.json`)
- npm

## Modèle de confiance

db-cluster s’exécute **localement**. Il lit et écrit dans un répertoire `.db-cluster/` dans le répertoire de travail que vous lui indiquez, et il lit les artefacts que vous lui transmettez via `ingest`. Il n’y a **pas de communication réseau sortante** par défaut et **pas de télémétrie**. La seule connexion sortante facultative est vers un hôte Postgres si vous définissez `DB_CLUSTER_POSTGRES_URL`. **db-cluster ne configure pas SSL/TLS pour cette connexion dans la version 1.0.0** : le transport est en texte clair, sauf si votre chaîne de connexion l’impose (par exemple, `sslmode=require`, ce que le pilote `pg` respecte), un proxy de terminaison TLS ou un réseau privé. La configuration TLS gérée par le pilote est prévue pour une future version.

Les outils du serveur MCP lisent et écrivent uniquement dans les référentiels locaux : ils n’atteignent jamais le réseau, et les réponses structurées `AiErrorEnvelope` ne divulguent jamais les traces de pile ou les chemins du système de fichiers. **Le serveur MCP utilise par défaut la zone de confiance `ai-facing` avec l’expurgation activée** : le contenu des artefacts et les attributs d’entité sensibles sont supprimés par défaut à la limite, et aucun outil MCP ne renvoie des octets d’artefacts bruts. Un opérateur qui a besoin du rôle privilégié (`internal` / `cluster-admin`) doit explicitement y adhérer via un indicateur d’environnement (provisoirement `DB_CLUSTER_MCP_ALLOW_PRIVILEGED`; voir [`docs/mcp.md`](docs/mcp.md)). **Les outils d’écriture MCP appliquent l’approbation** : `cluster_commit_mutation` et `cluster_compensate_mutation` refusent d’écrire tant que la commande n’est pas dans l’état `approuvé` : l’appelant doit d’abord appeler `cluster_approve_mutation`, et le refus est une `AiErrorEnvelope` structurée, et non une écriture partielle. (Les appelants SDK en processus de confiance ne sont pas affectés : cette porte est uniquement pour la surface MCP.) Les commandes CLI destructrices (`restore`, `rebuild index`, `compensate`, `backup --force-overwrite`) nécessitent un indicateur explicite `--yes` ainsi qu’une confirmation interactive sur le TTY.

Le modèle de menace complet (données concernées, données NON concernées, autorisations requises, posture par surface et résidus suivis) est disponible dans [`SECURITY.md`](SECURITY.md).

## Documentation

Consultez le fichier [`docs/README.md`](docs/README.md) pour obtenir la liste complète des documents (Commencez ici / Référence / Historique de la phase de développement). Points importants :

- [Guide de démarrage rapide](docs/quickstart.md) — procédure optimale en 5 minutes
- [Manuel](docs/handbook.md) — guide de référence pour les opérateurs et les développeurs
- [Architecture](docs/architecture.md) — modèle de vérité fédéré + les sept lois de l’architecture
- [Contrats de stockage](docs/store-contracts.md) — ce que chaque module de stockage possède et garantit
- [Loi sur la mutation](docs/mutation-law.md) / [Graphes de provenance](docs/provenance-graphs.md) — cycle de vie de l’écriture sécurisée et suivi de la lignée
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — références
- [Politique et masquage](docs/policy-and-redaction.md) — Principal, Capacité, Politique, TrustZone
- [Opérations](docs/operations.md) — diagnostic, vérification, reconstruction, sauvegarde, restauration
- [Manuels d’utilisation pour les opérateurs](docs/runbooks/README.md) — un manuel par classe d’erreurs
- [Préparation au lancement](docs/release-readiness.md) — flux de lancement + schémas d’erreurs connus

## Licence

MIT
