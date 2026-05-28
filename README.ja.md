<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**AIネイティブな分散データベースクラスタ。** 特定の役割を持つデータストアが、単一の管理基盤として機能します。型付きエラー、構造化されたエラーコード、ミューテーションの記録、MCP（Management Console Platform）+ SDK（Software Development Kit）+ CLI（Command Line Interface）を提供します。

## これはどのようなユーザーのためのものですか？

- **AIエージェント:** 信頼性の高いデータ取得、構造化されたエラー通知、および状態を静かに破損させないミューテーションライフサイクルを必要とするエージェント。
- **運用担当者:** グラフおよびトレーサビリティストアを運用しており、型付きのエラーコード、診断機能（ドクター/検証）、運用手順書、および安全なバックアップ/リストア機能を必要とする担当者。
- **開発者:** クラスタをバックエンドとするアプリケーションを開発しており、明確な公開API、初期設定時の動作確認テスト、および各メソッドごとのJSDocとサンプルコードを必要とする開発者。
- **ダッシュボード利用者:** クラスタのデータ整合性を監査し、データストアの所有権、トレーサビリティ、コマンドプレビュー、およびデータマスキングビューを確認したい利用者。

## なぜdb-clusterを使用するのか？

- **`remediationHint`付きの型付きエラー:** `ClusterError`のすべてのサブクラスが、何が失敗したかを伝えるだけでなく、**何をすべきか**を指示します（CLIのエラーコード65/70/77/78が、型付きエラーコードに対応）。
- **AIエラー通知:** `{code, message, retryable, remediation_hint, context, next_valid_actions}`というスキーマで構成されます。AIエージェントは、自然言語を解析する代わりに、`code`や`retryable`に基づいて処理を分岐できます。
- **すべてのミューテーションに対する記録:** コンテンツアドレス指定方式で、トレーサビリティグラフを構築し、インデックスストアに対して「真実からの再構築」という契約を適用します。
- **安全機能付きのMCPサーバー:** 読み取り専用、ステージング、承認、書き込みツールは、それぞれ機械可読な`readOnlyHint`または`destructiveHint`フラグを持ちます。
- **ポリシー適用機能付きのSDK:** `PolicyEnforcedKernel`のみが利用可能であり、`ClusterKernel`は意図的に公開されていません。

## クイックスタート（3ステップ）

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

または、グローバルにインストールし、`db-cluster` および `db-cluster-mcp` コマンドを直接使用することもできます。

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

または、Docker を使用して実行することもできます（Node.js のインストールは不要です）。

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

完全な手順: [`docs/quickstart.md`](docs/quickstart.md) (5分)。

## これは何ですか？

分散データベースクラスタであり、以下の要素で構成されます。

- **カノニカルストア:** エンティティ、ID、安定した状態のレコード。
- **アーティファクトストア:** 生データ、ドキュメント、ソーステキスト、生成された出力。
- **インデックスストア:** 発見可能性、全文/ベクトル検索、メタデータ検索。
- **イベント/トレーサビリティレジャー:** アクション、リンク、ミューテーション、記録、トレーサビリティ。

カーネルがルーティングを行い、インデックスが検索を行い、クラスタがデータの整合性を維持します。

## これは何ではありませんか？

- AIデータベースアシスタント
- 多数のストアに対するインデックス
- 統制ミドルウェア
- プラグイン付きのベクトルデータベース
- エージェントのメモリ層

## アーキテクチャの原則

1. すべてのデータには、所有するストアが存在します。
2. インデックスは派生データであり、所有するストアから削除および再構築できます。
3. AIは、生のデータを直接変更することはありません。
4. すべてのデータは、元のデータソースにトレース可能です。
5. すべての変更は、型付きのコマンド境界を通過します。
- アーティファクトのデータは、デフォルトで不変です。修正を行う場合は、上書きではなくバージョンを作成します。
6. カーネルがルーティングを行い、クラスタがデータの整合性を維持します。

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

完全なCLIリファレンス（型付きエラーのエラーコード表を含む）については、[`docs/cli.md`](docs/cli.md)を参照してください。

## ステータス

**v1.0.0 — リリース済み。** db-clusterは、内部テスト環境全体で監査に対応しています。
- Stage A（正確性、Waves A1–A4）、Stage B（積極的なヘルスチェック、Wave B1-Amend）、およびStage C（人間化、Wave C1-Amend）の各段階を通過しています。
- **1247以上のテストが、83のファイルで決定的に成功**。リリースゲートは9/9すべてPASS、Lintも問題ありません。

### v1.0.0の変更点

- **連合型真実モデル** — カノニカルデータ、アーティファクト、インデックス、レジャーの格納場所; カーネルはルートを管理し、クラスターが所有; インデックスは派生データ。
- **エラーに `remediationHint` を付与** — `ClusterError` を基本とし、各クラスごとにサブクラスを作成; CLI は sysexits.h (65/70/77/78) に対応; `AiErrorEnvelope` はすべての AI 境界で利用。
- **ミューテーションのライフサイクル** — 提案 → 検証 → 承認 → コミット → (補償)。すべてのコミットで、コンテンツアドレス指定されたレシートを発行。
- **MCP サーバー** — 安全性に関する注釈 (`readOnlyHint` / `destructiveHint` / `requiresApprovalHint`) が付与された 16 のツール; 構造化されたエラー結果のみで、スタックトレースは表示されない。
- **ポリシーとマスキング** — `PolicyEnforcedKernel` はエクスポートされるカーネルのエントリポイント; `Principal`、`Capability`、`Policy`、`TrustZone`、`VisibilityRule` などの型; すべての読み込みパスでマスキングを行う。
- **オペレーターインターフェース** — `doctor`、`verify`、`インデックスの再構築`、`バックアップ`、`リストア`、`補償`、`移行状況`。破壊的なコマンドは `--yes` オプションとインタラクティブな TTY 確認によって制限される。
- **ダッシュボードのデモ** — クラスターの真実情報を表示する React ダッシュボード (`dashboard/`)。`ComponentState<T>` と `StateBoundary` HOC を使用して、読み込み中、空の状態、エラー状態を表示。
- **リリースゲート** — `scripts/release-gate.mjs` によって強制される 9 つのステージ: ビルド、テスト、パッケージング、簡易インストール、ドキュメントの変更検出、パッケージのエクスポート、完全性チェック、ドキュメントの変更検出、JSDoc の完全性チェック。

### v1.x の追跡対象残項

- `V2-C1-009` — 長時間実行される MCP 処理 (doctor/verify/rebuild/backup/restore) は、現在、単一のツールとして提供されます。詳細な進行状況のストリーミングはドキュメントに記載されていますが、v1.0.0 には含まれていません。詳細は [`docs/release-readiness.md`](docs/release-readiness.md) を参照してください。
- `KERNEL-C-012` — OperatorSignal クロスドメインチャネルは、v1.1 以降のアーキテクチャ拡張です。
- Stryker によるミューテーションテストは実装されています (`npm run test:mutation`)。ただし、実験的なものであり、v2 の dogfood-swarm verifier-3 のドクトリンに従って、標準のリリースゲートには含まれていません。

### Dogfood-swarm の履歴

ステージ A (正確性、Waves A1–A4) → ステージ B (積極的なヘルスチェック、Wave B1-Amend) → ステージ C (人間化、Wave C1-Amend) → **ステージ D はフェーズ 10 の完全な改善に統合** (ロゴ、ランディングページ、ハンドブック、CLI のカラー調整)。ステージ D の swarm wave は実施されていません。完全な監査履歴は [`CHANGELOG.md`](CHANGELOG.md) およびリポジトリのルートにある `swarm-stage-*-*.md` レポートに記載されています。

## 前提条件

- Node.js 20 以降 (package.json の `engines.node` で強制)
- npm

## 信頼モデル

db-cluster は **ローカル** で実行されます。`.db-cluster/` ディレクトリに読み書きを行い、`ingest` に渡すアーティファクトを読み取ります。
デフォルトでは **ネットワークへのアクセスはありません**。また、テレメトリーもありません。オプションで、`DB_CLUSTER_POSTGRES_URL` を設定した場合にのみ、Postgres ホストへの接続が可能です (この場合、`DB_CLUSTER_POSTGRES_SSL` も考慮されます)。

MCP サーバーのツールは、ローカルのストレージのみを読み書きします。ネットワークにアクセスすることはありません。また、構造化された `AiErrorEnvelope` の応答には、スタックトレースやファイルシステムのパスは含まれません。破壊的な CLI コマンド (`restore`、`インデックスの再構築`、`補償`、`バックアップ --force-overwrite`) は、明示的な `--yes` オプションと、TTY 上でのインタラクティブな確認が必要です。

完全な脅威モデル (アクセスされるデータ、アクセスされないデータ、必要な権限、各インターフェースの詳細、追跡対象残項) は、[`SECURITY.md`](SECURITY.md) に記載されています。

## ドキュメント

完全なドキュメントマップは [`docs/README.md`](docs/README.md) を参照してください (ここから開始 / 参照 / 開発履歴)。主な内容:

- [クイックスタート](docs/quickstart.md) - 5分でわかる基本
- [ハンドブック](docs/handbook.md) - 標準的な操作手順 + 開発者向けガイド
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) - 関連ドキュメントへのリンク
- [ポリシーと編集](docs/policy-and-redaction.md) - プリンシパル、キャパシティ、ポリシー、トラストゾーン
- [操作](docs/operations.md) - 診断、検証、ビルド、バックアップ、復元
- [オペレーター向け操作マニュアル](docs/runbooks/README.md) - エラーの種類ごとに1つの操作マニュアル
- [リリース準備](docs/release-readiness.md) - リリースフロー + 既知の問題点

## ライセンス

マサチューセッツ工科大学
