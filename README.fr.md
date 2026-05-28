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
</p>

**Cluster de bases de données fédérées, conçu pour l'IA.** Des espaces de stockage spécialisés qui fonctionnent comme une infrastructure unifiée, avec gestion des erreurs typées, codes de sortie structurés, accusés de réception des modifications, API, SDK et interface en ligne de commande.

## À qui s'adresse ce produit ?

- **Agents d'IA** qui ont besoin d'une récupération fiable, de structures d'erreur structurées et d'un cycle de vie des modifications qui empêche la corruption silencieuse des données.
- **Administrateurs** qui utilisent des bases de données graphes et de provenance et qui souhaitent des codes de sortie typés, des diagnostics de vérification, des guides de dépannage et des sauvegardes/restaurations sécurisées.
- **Développeurs** qui créent des applications basées sur des clusters et qui souhaitent une API publique bien définie, des tests de démarrage, et une documentation JSDoc détaillée avec des exemples pour chaque méthode.
- **Utilisateurs de tableaux de bord** qui auditent l'intégrité du cluster : propriété des données, traçabilité, aperçu des commandes, masquage des données.

## Pourquoi utiliser db-cluster ?

- **Erreurs typées avec `remediationHint`** : chaque sous-classe de `ClusterError` indique CE QU'IL FAUT FAIRE, et non seulement CE QUI a échoué (codes de sortie de l'interface en ligne de commande 65/70/77/78 mappés à des codes d'erreur typés).
- **Enveloppes d'erreurs pour l'IA** : schéma `{code, message, retryable, remediation_hint, context, next_valid_actions} ; les agents d'IA peuvent utiliser `code` et `retryable` au lieu d'analyser du texte.
- **Accusés de réception pour chaque modification** : adressables par contenu ; graphe de traçabilité ; contrat de reconstruction à partir de la source de vérité pour le magasin d'index.
- **Serveur MCP avec annotations de sécurité** : les outils de lecture seule, de mise en attente, d'approbation et d'écriture comportent des indicateurs `readOnlyHint` et `destructiveHint` lisibles par machine.
- **SDK avec application de politiques** : `PolicyEnforcedKernel` est le seul chemin d'accès ; `ClusterKernel` n'est intentionnellement pas exporté.

## Démarrage rapide (3 étapes)

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

Ou installez globalement et utilisez directement les exécutables `db-cluster` et `db-cluster-mcp` :

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

Ou exécutez via Docker (aucune installation de Node.js n'est requise) :

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

Chemin complet : [`docs/quickstart.md`](docs/quickstart.md) (5 minutes).

## Qu'est-ce que c'est ?

Un cluster de bases de données fédérées où :

- **Magasin canonique** : entités, identifiants, enregistrements d'état stable.
- **Magasin d'artefacts** : fichiers bruts, documents, texte source, résultats générés.
- **Magasin d'index** : découverte, recherche en texte intégral/vectorielle, recherche de métadonnées.
- **Registre d'événements/de provenance** : actions, liens, modifications, accusés de réception, traçabilité.

Le noyau gère le routage. L'index assure la découverte. Le cluster garantit l'intégrité des données.

## Ce que ce n'est pas

- Un assistant de base de données pour l'IA.
- Un index sur de nombreux magasins.
- Un middleware de gouvernance.
- Une base de données vectorielle avec des plugins.
- Une couche de mémoire pour les agents.

## Principes d'architecture

1. Chaque fait a un magasin propriétaire.
2. Les index sont dérivés et peuvent être supprimés et reconstruits à partir des magasins propriétaires.
3. L'IA ne modifie jamais directement l'état brut.
4. Chaque réponse est traçable à la source de vérité.
5. Chaque modification respecte une limite de commande typée.
6. La vérité des artefacts est immuable par défaut ; les corrections créent des versions, et non des remplacements.
7. Le noyau gère le routage ; le cluster garantit l'intégrité des données.

## Interface en ligne de commande (CLI)

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

Consultez [`docs/cli.md`](docs/cli.md) pour la référence complète de l'interface en ligne de commande (y compris le tableau des codes de sortie typés).

## Statut

**v1.0.0 — Disponible.** db-cluster est sécurisé et auditable sur l'ensemble du réseau de test.
Protocole — Phase A (correction, vagues A1–A4), Phase B (amélioration proactive, vague B1-Amend), et Phase C (humanisation, vague C1-Amend).
**Plus de 1247 tests réussis** de manière déterministe sur 83 fichiers, validation de la version réussie (9/9), analyse statique propre.

### Ce qui est inclus dans la version 1.0.0

- **Modèle de vérité fédéré** — référentiel, artefacts, index, stockage de journaux ; le noyau gère les routes, le cluster est propriétaire ; l'index est dérivé.
- **Erreurs typées avec `remediationHint` partout** — classe de base `ClusterError` + sous-classes spécifiques à chaque classe ; la CLI correspond aux codes de sortie système (65/70/77/78) ; `AiErrorEnvelope` à chaque limite de l'IA.
- **Cycle de vie des mutations** — proposer → valider → approuver → commettre → (compenser). Chaque commit génère un reçu avec une adresse de contenu.
- **Serveur MCP** — 16 outils avec annotations de sécurité (`readOnlyHint` / `destructiveHint` / `requiresApprovalHint`); résultats d'erreur structurés, jamais de traces de pile brutes.
- **Politiques et masquage** — `PolicyEnforcedKernel` est la seule entrée de noyau exportée ; types `Principal`, `Capability`, `Policy`, `TrustZone`, `VisibilityRule` ; masquage à chaque chemin de lecture.
- **Interface utilisateur pour les opérateurs** — `doctor`, `verify`, `reconstruire l'index`, `sauvegarde`, `restauration`, `compensation`, `état de la migration`. Les commandes destructives nécessitent le flag `--yes` et une confirmation interactive via TTY.
- **Démonstration du tableau de bord** — tableau de bord React en lecture seule pour la vérité du cluster (`dashboard/`), avec `ComponentState<T>` + `StateBoundary` HOC pour les états de chargement/vide/erreur.
- **Porte de publication** — 9 étapes imposées par `scripts/release-gate.mjs` : construction, tests, empaquetage, installation de test, détection de dérive documentaire, exportations de packages, exhaustivité, dérive documentaire, exhaustivité JSDoc.

### Résidus suivis pour la version 1.x

- `V2-C1-009` — Les opérations MCP de longue durée (doctor/verify/rebuild/backup/restore) sont actuellement proposées sous forme d'outils ponctuels ; la diffusion progressive est documentée mais pas dans la version 1.0.0. Voir [`docs/release-readiness.md`](docs/release-readiness.md).
- `KERNEL-C-012` — Le canal `OperatorSignal` inter-domaines est une extension architecturale de la version 1.1+.
- Les tests de mutation Stryker sont inclus (`npm run test:mutation`) mais sont expérimentaux — ils ne font pas partie du processus de publication standard, conformément à la doctrine du vérificateur v2 "dogfood-swarm".

### Historique de "dogfood-swarm"

Étape A (correction, vagues A1 à A4) → Étape B (amélioration proactive, vague B1-Amend) → Étape C (humanisation, vague C1-Amend) → **Étape D est intégrée à la phase 10 de traitement complet** (logo, page d'accueil, manuel, amélioration des couleurs de la CLI). Aucune vague d'étape D n'a été déployée. L'historique complet se trouve dans [`CHANGELOG.md`](CHANGELOG.md) et dans les rapports `swarm-stage-*-*.md` à la racine du dépôt.

## Prérequis

- Node.js 20+ (imposé via `engines.node` dans `package.json`)
- npm

## Modèle de confiance

`db-cluster` s'exécute **localement**. Il lit et écrit dans un répertoire `.db-cluster/` dans le
répertoire de travail que vous spécifiez et lit les artefacts que vous passez à `ingest`.
Il n'y a **pas de sortie réseau** par défaut et **pas de télémétrie**. La seule
connexion sortante facultative est vers un serveur Postgres si vous définissez
`DB_CLUSTER_POSTGRES_URL` (avec respect de `DB_CLUSTER_POSTGRES_SSL`).

Les outils du serveur MCP lisent et écrivent uniquement dans les magasins locaux ; ils n'atteignent jamais
le réseau, et les réponses structurées `AiErrorEnvelope` ne divulguent jamais de traces de pile ou de
chemins d'accès au système de fichiers. Les commandes CLI destructrices (`restauration`, `reconstruction de l'index`,
`compensation`, `sauvegarde --force-overwrite`) nécessitent un flag `--yes` explicite et une
confirmation interactive via TTY.

Le modèle de menace complet — données traitées, données NON traitées, permissions requises,
état de chaque interface, et résidus suivis — se trouve dans
[`SECURITY.md`](SECURITY.md).

## Documentation

Voir [`docs/README.md`](docs/README.md) pour la carte complète de la documentation (Commencer ici /
Référence / Historique de la phase de développement). Points importants :

- [Guide de démarrage rapide](docs/quickstart.md) — Guide pour une prise en main en 5 minutes.
- [Manuel](docs/handbook.md) — Guide de référence pour les opérateurs et les développeurs.
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — Références d'accès.
- [Politique et masquage](docs/policy-and-redaction.md) — Principes, capacités, politiques, TrustZone.
- [Opérations](docs/operations.md) — Diagnostic, vérification, reconstruction, sauvegarde, restauration.
- [Manuels d'utilisation](docs/runbooks/README.md) — Un manuel par classe d'erreur.
- [Préparation à la publication](docs/release-readiness.md) — Flux de publication et schémas de problèmes connus.

## Licence

MIT
