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

**従来のデータベースは、慎重で決定的な呼び出し元を前提としています。AIエージェントはそうではありません。**
従来のストアは、人間が開発用に記述したエラーをエージェントに渡し、有効であればすぐに書き込みを行い、クエリが参照するすべてのフィールドを返します。そのため、エージェントは次に何をすべきかを確実に判断できず、プロンプトインジェクションとデータの間に何も障壁がなく、機密情報がコンテキストウィンドウに直接入ってしまいます。db-clusterは、この不一致を起点として設計されました。単一のポリシーによって制御されるカーネルの背後で、1つのクラスタとして実行される、特殊な信頼できるストアです。エージェントのニーズに合わせて、次に何をすべきかを指示する型付きエラー、引用可能な証拠バンドルを返す検索、すべての読み取りパスでの編集、プロンプトインジェクションによってストアが静かに破損しないようにする、提案→承認→コミットのライフサイクルを提供します。デフォルトではローカルで、スケールアウトする場合はPostgresとSQLiteを使用し、CLI、SDK、MCPを通じてアクセスできます。

## これは誰のためのものですか？

- 信頼できる検索、構造化されたエラーエンベロープ、および状態を静かに破損させないミューテーションライフサイクルを必要とする**AIエージェント**。
- 型付きの終了コード、診断/検証ツール、運用手順書、および安全なバックアップ/リストアを希望する、グラフ+プロベナンスストアを運用する**オペレーター**。
- 明確なパブリックAPI、新規インストール時のスモークテスト、およびメソッドごとのJSDoc + 例を必要とする、クラスタをバックエンドとするアプリケーションを構築する**開発者**。
- クラスタの信頼性を監査する**ダッシュボードの閲覧者**（ストアの所有権、プロベナンスの系統、コマンドのプレビュー、編集ビュー）。

## なぜdb-clusterを使用するのか？

- **`remediationHint`付きの型付きエラー** - すべての`ClusterError`サブクラスは、何が失敗したかだけでなく、次に何をすべきかを回答します（CLIの終了コード65/70/77/78は、型付きエラーコードにマッピングされます）。
- **AIエラーエンベロープ** - `{code, message, retryable, remediation_hint, context, next_valid_actions}`スキーマ。AIエージェントは、プロ​​ースを解析する代わりに、`code`と`retryable`に基づいてブランチできます。
- **すべてのミューテーションに対するレシート** - コンテンツアドレス指定可能。プロベナンスグラフ。インデックスストアの真実からの再構築契約。
- **安全アノテーション付きのMCPサーバー** - 読み取り専用/ステージング/承認/書き込みツールはそれぞれ、機械可読の`readOnlyHint`/`destructiveHint`フラグを持ちます。サーバーはデフォルトで`ai-facing`信頼ゾーン（編集ON、生のコンテンツなし）になり、MCP書き込みツールは、コマンドが`承認`されるまでコミットを拒否します。
- **デフォルトでポリシーによって強制** - パッケージのルートファクトリ`createSafeCluster()`は、ポリシーによって制御されたハンドル（`PolicyEnforcedKernel` + 読み取り専用操作、生のストアミューテーターなし）を返します。生の、ポリシーによって制御されていないストアには、明示的な`@mcptoolshop/db-cluster/unsafe`エスケープハッチを通じてのみアクセスできます。

## クイックスタート（3ステップ）

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

または、グローバルにインストールして、`db-cluster`と`db-cluster-mcp`のbinを直接使用します。

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

または、Docker経由で実行します（Nodeのインストールは不要）。

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

完全なベストプラクティスの手順：[`docs/quickstart.md`](docs/quickstart.md)（5分）。

## これは何ですか？

次のような、フェデレーションされたデータベースクラスタです。

- **カノニカルストア** - エンティティ、ID、安定した状態のレコード
- **アーティファクトストア** - 生のファイル、ドキュメント、ソーステキスト、生成された出力
- **インデックスストア** - 発見可能性、全文（ランク付けされた）検索、メタデータ検索
- **イベント/プロベナンスレジャー** - アクション、リンク、ミューテーション、レシート、系統

カーネルがルーティングします。インデックスが発見します。クラスタが真実を所有します。

「フェデレーション」とは、これらのストアが異なるバックエンドで実行できることを意味します。現在のところ、Postgresバックエンドは**カノニカルストアにのみ**適用され、アーティファクト、インデックス、およびレジャーストアは、ローカルまたはSQLiteバックエンドで実行されます。

## これは何ではありませんか？

- AIデータベースアシスタント
- 複数のストアにわたるインデックス
- ガバナンスミドルウェア
- プラグインを備えたベクトルデータベース
- エージェントのメモリレイヤー

## アーキテクチャの法則

1. すべての事実は、所有ストアを持つ
2. インデックスは派生したものであり、削除して、所有ストアから再構築できる
3. AIは、生の状態を直接変更しない
4. すべての回答は、ソースの真実に遡る
5. すべてのミューテーションは、型付きのコマンド境界を通過する
6. アーティファクトの真実は、デフォルトで不変である。修正は、上書きではなく、バージョンを作成する
7. カーネルがルーティングし、クラスタが所有する

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

- Node.js 20+（`package.json`の`engines.node`によって強制されます）
- npm

## 信頼モデル

db-clusterは**ローカルで**実行されます。指定した作業ディレクトリにある`.db-cluster/`ディレクトリを読み書きし、`ingest`に渡されたアーティファクトを読み取ります。デフォルトでは**ネットワークへの送信は行われず、テレメトリも行われません**。オプションの送信接続は、`DB_CLUSTER_POSTGRES_URL`を設定した場合に、Postgresホストへの接続のみです。**db-clusterは、v1.0.0では、その接続に対してSSL/TLSを構成しません**。トランスポートはプレーンテキストであり、接続文字列で強制しない限り（例：`sslmode=require`、これは`pg`ドライバーが尊重します）、TLS終端プロキシ、またはプライベートネットワークを使用します。ドライバーによって管理されるTLS構成は、将来のリリースで計画されています。

MCPサーバーツールは、ローカルストレージへの読み書きのみを行います。ネットワークにはアクセスせず、構造化された`AiErrorEnvelope`レスポンスには、スタックトレースやファイルシステムパスが漏洩することはありません。**MCPサーバーは、デフォルトで`ai-facing`トラストゾーンを使用し、リダクションが有効になっています。**そのため、デフォルトでは、成果物のコンテンツや機密性の高いエンティティ属性が境界で削除され、どのMCPツールも生の成果物バイトを返しません。特権的な（`internal` / `cluster-admin`）アクセスが必要なオペレーターは、環境フラグ（仮に`DB_CLUSTER_MCP_ALLOW_PRIVILEGED`）を通じて明示的にオプトインする必要があります（詳細は[`docs/mcp.md`](docs/mcp.md)を参照）。**MCP書き込みツールは、承認を強制します。**`cluster_commit_mutation`と`cluster_compensate_mutation`は、コマンドが`approved`ステータスでない限り、書き込みを拒否します。そのため、呼び出し元は最初に`cluster_approve_mutation`を呼び出す必要があり、拒否は部分的な書き込みではなく、構造化された`AiErrorEnvelope`として行われます。（信頼されたインプロセスSDKの呼び出し元は影響を受けません。これはMCPの表面でのみ適用されます。）破壊的なCLIコマンド（`restore`、`rebuild index`、`compensate`、`backup --force-overwrite`）には、明示的な`--yes`フラグと、TTYでのインタラクティブな確認が必要です。

完全な脅威モデル（アクセスされるデータ、アクセスされないデータ、必要な権限、表面ごとのアクセス制御、追跡される残存データ）は、[`SECURITY.md`](SECURITY.md)に記載されています。

## ドキュメント

完全なドキュメントマップについては、[`docs/README.md`](docs/README.md)を参照してください（ここから開始 / リファレンス / 開発段階の履歴）。主な内容：

- [クイックスタート](docs/quickstart.md) — 5分で完了する基本的な手順
- [ハンドブック](docs/handbook.md) — 標準的なオペレーターおよび開発者向けガイド
- [アーキテクチャ](docs/architecture.md) — フェデレーションされた真実モデル + 7つのアーキテクチャの法則
- [ストアコントラクト](docs/store-contracts.md) — 各4つのストアが所有および保証するもの
- [ミューテーション法則](docs/mutation-law.md) / [プロベナンスグラフ](docs/provenance-graphs.md) — 安全な書き込みライフサイクルと系統追跡
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — 表面リファレンス
- [ポリシーとリダクション](docs/policy-and-redaction.md) — プリンシパル、キャパビリティ、ポリシー、トラストゾーン
- [運用](docs/operations.md) — 診断、検証、再ビルド、バックアップ、復元
- [オペレーターランブック](docs/runbooks/README.md) — エラータイプごとに1つのランブック
- [リリース準備](docs/release-readiness.md) — リリースフロー + 既知の不安定なパターン

## ライセンス

MIT
