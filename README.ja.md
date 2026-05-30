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
  <a href="https://github.com/mcp-tool-shop-org/db-cluster/pkgs/container/db-cluster"><img src="https://img.shields.io/badge/ghcr.io-db--cluster-2496ED?logo=docker" alt="Docker image on GHCR" /></a>
</p>

**AIネイティブのフェデレーションデータベースクラスタ。** 1つの管理された基盤として機能する、特殊な信頼できるデータストア。型付きエラー、構造化された終了コード、変更の記録、MCP + SDK + CLIインターフェース。

「フェデレーション」とは、異なるバックエンドで実行できる特殊な信頼できるデータストアを意味します。Postgresバックエンドは、現在は**標準ストアのみ**に適用されます。アーティファクト、インデックス、および台帳ストアは、ローカル/SQLiteバックエンドで実行されます。

## これは誰のためのものですか？

- 信頼できるデータの取得、構造化されたエラー情報、および状態を静かに破損させない変更ライフサイクルを必要とする**AIエージェント**。
- 型付きの終了コード、診断/検証ツール、運用手順書、および安全なバックアップ/リストアを希望する、グラフ+プロベナンスストアを運用する**オペレーター**。
- 意図的なパブリックAPI、新規インストール時のスモークテスト、およびメソッドごとのJSDoc + 例を必要とする、クラスタベースのアプリケーションを構築する**開発者**。
- クラスタの信頼できるデータを監査する**ダッシュボードの閲覧者**。ストアの所有権、プロベナンスの系統、コマンドのプレビュー、および機密情報の削除ビュー。

## db-clusterを使用する理由

- **`remediationHint`付きの型付きエラー** — すべての`ClusterError`サブクラスは、何が失敗したかだけでなく、**何をすべきか**を回答します（CLI終了コード65/70/77/78は、型付きエラーコードにマッピングされます）。
- **AIエラー情報** — `{code, message, retryable, remediation_hint, context, next_valid_actions}`スキーマ。AIエージェントは、プログラミングされたテキストを解析する代わりに、`code`と`retryable`に基づいてブランチできます。
- **すべての変更に対する記録** — コンテンツアドレス指定可能。プロベナンスグラフ。インデックスストアでの真実からの再構築契約。
- **安全性の注釈付きのMCPサーバー** — 読み取り専用/ステージング/承認/書き込みツールはそれぞれ、機械可読の`readOnlyHint`/`destructiveHint`フラグを持ちます。サーバーはデフォルトで`ai-facing`信頼ゾーン（機密情報の削除が有効、生のコンテンツなし）になり、MCP書き込みツールは、コマンドが`approved`になるまでコミットを拒否します。
- **デフォルトでポリシーが適用** — パッケージのルートファクトリ`createSafeCluster()`は、ポリシーが適用されたハンドル（`PolicyEnforcedKernel` + 読み取り専用操作、生のストア変更ツールなし）を返します。ポリシーが適用されていない生のストアには、明示的な`@mcptoolshop/db-cluster/unsafe`エスケープハッチを介してのみアクセスできます。

## クイックスタート（3ステップ）

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

または、グローバルにインストールして、`db-cluster`と`db-cluster-mcp`のバイナリを直接使用します。

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

または、Docker経由で実行します（Node.jsのインストールは不要）。

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

完全なベストプラクティスの手順：[`docs/quickstart.md`](docs/quickstart.md)（5分）。

## これは何ですか？

次の機能を持つ、フェデレーションデータベースクラスタです。

- **標準ストア** — エンティティ、ID、安定した状態のレコード
- **アーティファクトストア** — 生のファイル、ドキュメント、ソーステキスト、生成された出力
- **インデックスストア** — 検索可能性、全文（ランク付けされた）検索、メタデータ検索
- **イベント/プロベナンス台帳** — アクション、リンク、変更、記録、系統

カーネルがルーティングします。インデックスが検出します。クラスタが真実を所有します。

## これは何ではありませんか？

- AIデータベースアシスタント
- 複数のストアにわたるインデックス
- ガバナンスミドルウェア
- プラグインを備えたベクトルデータベース
- エージェントのメモリレイヤー

## アーキテクチャの法則

1. すべての事実は、所有ストアを持ちます。
2. インデックスは派生したものであり、削除して、所有ストアから再構築できます。
3. AIは、生の状態を直接変更しません。
4. すべての回答は、ソースの真実に遡ります。
5. すべての変更は、型付きのコマンド境界を通過します。
6. アーティファクトの真実は、デフォルトで不変です。修正は、上書きではなく、バージョンを作成します。
7. カーネルがルーティングし、クラスタが所有します。

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

完全なCLIリファレンス（型付きエラーの終了コードテーブルを含む）については、[`docs/cli.md`](docs/cli.md)を参照してください。

## 前提条件

- Node.js 20+（`package.json`の`engines.node`で強制されます）
- npm

## 信頼モデル

db-clusterは**ローカルで**実行されます。指定した作業ディレクトリにある`.db-cluster/`ディレクトリを読み書きし、`ingest`に渡されたアーティファクトを読み取ります。デフォルトでは**ネットワークへの送信はありません**、また**テレメトリもありません**。唯一のオプションの送信接続は、`DB_CLUSTER_POSTGRES_URL`を設定した場合のPostgresホストへの接続です。**db-clusterは、v1.0.0では、その接続に対してSSL/TLSを構成しません**。接続文字列で強制しない限り（例：`sslmode=require`、これは`pg`ドライバが尊重します）、TLS終端プロキシ、またはプライベートネットワークを使用する場合、トランスポートはプレーンテキストになります。ドライバ管理のTLS構成は、将来のリリースで計画されています。

MCPサーバーツールは、ローカルストアのみを読み書きします。ネットワークに到達することはありません。構造化された`AiErrorEnvelope`レスポンスは、スタックトレースやファイルシステムパスを漏洩しません。**MCPサーバーはデフォルトで、機密情報の削除が有効になっている`ai-facing`信頼ゾーンになります**。アーティファクトのコンテンツと機密性の高いエンティティ属性は、境界でデフォルトで削除され、どのMCPツールも生のアーティファクトバイトを返しません。特権的な（`internal`/`cluster-admin`）状態を必要とするオペレーターは、環境フラグ（仮に`DB_CLUSTER_MCP_ALLOW_PRIVILEGED`）を介して明示的にオプトインする必要があります（[`docs/mcp.md`](docs/mcp.md)を参照）。**MCP書き込みツールは、承認を強制します**。`cluster_commit_mutation`と`cluster_compensate_mutation`は、コマンドが`approved`状態になるまで書き込みを拒否します。呼び出し元は、最初に`cluster_approve_mutation`を呼び出す必要があり、拒否は構造化された`AiErrorEnvelope`であり、部分的な書き込みではありません。（信頼できるインプロセスSDK呼び出し元は影響を受けません。これは、MCPサーフェスのみのゲートです）。破壊的なCLIコマンド（`restore`、`rebuild index`、`compensate`、`backup --force-overwrite`）には、明示的な`--yes`フラグと、TTYでのインタラクティブな確認が必要です。

完全な脅威モデル — 触れられたデータ、触れられていないデータ、必要な権限、サーフェスごとの状態、および追跡された残存物 — は、[`SECURITY.md`](SECURITY.md)にあります。

## ドキュメント

完全なドキュメントマップについては、[`docs/README.md`](docs/README.md) を参照してください（ここから開始 / リファレンス / 開発段階の履歴）。主な内容：

- [クイックスタート](docs/quickstart.md) — 5分で完了する基本的な手順
- [ハンドブック](docs/handbook.md) — 標準的なオペレーターおよび開発者向けガイド
- [アーキテクチャ](docs/architecture.md) — フェデレーションされた真実モデル + 7つのアーキテクチャの法則
- [ストアコントラクト](docs/store-contracts.md) — 4つのストアがそれぞれ所有および保証するもの
- [ミューテーション法則](docs/mutation-law.md) / [プロベナンスグラフ](docs/provenance-graphs.md) — 安全な書き込みライフサイクルと系統追跡
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — 関連リファレンス
- [ポリシーと機密処理](docs/policy-and-redaction.md) — プリンシパル、機能、ポリシー、トラストゾーン
- [運用](docs/operations.md) — 診断、検証、再ビルド、バックアップ、復元
- [オペレーターランブック](docs/runbooks/README.md) — エラータイプごとに1つのランブック
- [リリース準備](docs/release-readiness.md) — リリースフロー + 既知の不安定なパターン

## ライセンス

MIT
