<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.md">English</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**基于人工智能的联邦数据库集群。** 专门的、作为统一底层服务的存储系统，提供类型化的错误信息、结构化的退出码、变更记录，以及 MCP、SDK 和 CLI 接口。

## 适用对象

- **人工智能代理 (AI agents)**：需要可靠的数据检索、结构化的错误信息，以及不会导致其静默损坏状态的变更生命周期。
- **运维人员 (Operators)**：运行图数据库和溯源存储，希望获得类型化的退出码、诊断信息、操作手册，以及安全的数据备份/恢复功能。
- **开发人员 (Developers)**：构建集群支持的应用，希望拥有明确的公共 API、安装后的测试，以及每个方法的 JSDoc 文档和示例。
- **仪表盘用户 (Dashboard viewers)**：审计集群中的数据，包括数据所有权、溯源信息、命令预览和数据脱敏视图。

## 为什么使用 db-cluster

- **带有 `remediationHint` 的类型化错误信息**：每个 `ClusterError` 子类都提供“应该做什么”，而不仅仅是“发生了什么”（CLI 退出码 65/70/77/78 映射到类型化的错误码）。
- **人工智能错误信息包 (AI error envelopes)**：包含 `{code, message, retryable, remediation_hint, context, next_valid_actions}` 模式；人工智能代理可以根据 `code` 和 `retryable` 进行分支处理，而无需解析文本。
- **每个变更都有记录**：内容寻址；溯源图；索引存储可以从原始数据重建。
- **带有安全注解的 MCP 服务器**：只读/分阶段/审批/写入工具，每个工具都带有可供机器读取的 `readOnlyHint` / `destructiveHint` 标志。
- **带有策略执行的 SDK**：`PolicyEnforcedKernel` 是唯一的访问路径；`ClusterKernel` 故意不公开。

## 快速入门（3 步）

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

或者，全局安装并直接使用 `db-cluster` 和 `db-cluster-mcp` 命令：

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

或者，通过 Docker 运行（无需安装 Node）：

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

完整流程：[docs/quickstart.md](docs/quickstart.md) (5 分钟)。

## 这是什么

这是一个联邦数据库集群，包含：

- **主存储 (Canonical store)**：实体、ID、稳定状态记录。
- **文件存储 (Artifact store)**：原始文件、文档、源代码、生成输出。
- **索引存储 (Index store)**：可发现性、全文/向量搜索、元数据搜索。
- **事件/溯源记录 (Event/provenance ledger)**：操作、链接、变更、记录、溯源信息。

核心路由；索引发现；集群拥有数据真值。

## 这不是什么

- 人工智能数据库助手
- 多个存储的索引
- 治理中间件
- 带插件的向量数据库
- 代理内存层

## 架构原则

1. 每个数据都有其所有者存储。
2. 索引是衍生数据，可以被删除并从所有者存储中重建。
3. 人工智能不会直接修改原始数据。
4. 每个答案都可追溯到原始数据来源。
5. 每个变更都经过类型化的命令边界。
6. 文件数据的真值默认是不可变的，修改会创建版本，而不是覆盖。
7. 核心路由；集群拥有。

## 命令行工具 (CLI)

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

请参阅 [docs/cli.md](docs/cli.md)，了解完整的 CLI 参考（包括类型化的错误退出码表）。

## 状态

**v1.0.0 — 已发布。** db-cluster 经过审计加固，适用于整个内部测试环境。
协议：A 阶段（正确性，A1–A4 阶段），B 阶段（主动健康，B1-Amend 阶段），C 阶段（人性化，C1-Amend 阶段）。
**1247+ 个测试通过**，所有 83 个文件均通过，发布门禁 9/9 通过，代码风格检查通过。

### v1.0.0 版本包含的内容

- **联邦真值模型** — 规范、数据制品、索引、账本存储；核心组件负责路由，集群负责管理；索引是衍生数据。
- **带有 `remediationHint` 的类型错误** — `ClusterError` 作为基础类，并为每个子类提供特定的错误处理；CLI 命令映射到 `sysexits.h` (65/70/77/78)；`AiErrorEnvelope` 出现在每个 AI 边界。
- **变更生命周期** — 提案 → 验证 → 批准 → 提交 → (补偿)。 每次提交都会生成一个内容寻址的凭证。
- **MCP 服务器** — 16 个工具，带有安全注解 (`readOnlyHint` / `destructiveHint` / `requiresApprovalHint`)；结构化的错误结果，不包含原始堆栈信息。
- **策略与数据脱敏** — `PolicyEnforcedKernel` 是唯一导出的内核入口；`Principal`、`Capability`、`Policy`、`TrustZone`、`VisibilityRule` 等类型；在所有读取路径上进行数据脱敏。
- **操作界面** — `doctor`、`verify`、`rebuild index`（重建索引）、`backup`（备份）、`restore`（恢复）、`compensate`（补偿）、`migration-status`（迁移状态）。 具有破坏性的命令需要 `--yes` 参数，并进行交互式 TTY 确认。
- **仪表盘演示** — 仅供查看的 React 仪表盘，用于显示集群的真值数据 (`dashboard/`)，使用 `ComponentState<T>` 和 `StateBoundary` HOC 来处理加载、空状态和错误状态。
- **发布流程** — 由 `scripts/release-gate.mjs` 脚本强制执行 9 个阶段：构建、测试、打包、快速安装、文档检查、包导出、完整性检查、文档一致性检查、JSDoc 完整性检查。

### v1.x 版本的跟踪残留问题

- `V2-C1-009` — 目前，长时间运行的 MCP 操作（doctor/verify/rebuild/backup/restore）以单次操作工具的形式呈现；细粒度的进度流式传输已记录，但未包含在 v1.0.0 版本中。 详情请参阅 [`docs/release-readiness.md`](docs/release-readiness.md)。
- `KERNEL-C-012` — OperatorSignal 跨域通道是 v1.1+ 版本的架构扩展。
- Stryker 变异测试已集成 (`npm run test:mutation`)，但处于实验阶段，不包含在 v2 的正式发布流程中，具体请参考 v2 dogfood-swarm verifier-3 的相关文档。

### Dogfood-swarm 的历史

阶段 A (正确性，Waves A1–A4) → 阶段 B (主动健康检查，Wave B1-Amend) → 阶段 C (人性化，Wave C1-Amend) → **阶段 D 融入到阶段 10 的全面改进** (包括 logo、着陆页、手册、以及 CLI 命令的颜色优化)。 没有发布过阶段 D 的 swarm wave。 完整的变更记录请参阅 [`CHANGELOG.md`](CHANGELOG.md) 以及仓库根目录下的 `swarm-stage-*-*.md` 报告。

## 先决条件

- Node.js 20+ (通过 `package.json` 中的 `engines.node` 强制)
- npm

## 信任模型

`db-cluster` 运行在 **本地**。 它会在您指定的
工作目录下的 `.db-cluster/` 目录中读取和写入数据，并读取传递给 `ingest` 命令的数据制品。
默认情况下，**没有网络出站连接**，**也没有任何遥测数据**。 唯一的
可选出站连接是连接到 PostgreSQL 服务器，前提是您设置了
`DB_CLUSTER_POSTGRES_URL` (同时需要设置 `DB_CLUSTER_POSTGRES_SSL` 以启用 SSL)。

MCP 服务器工具只读取和写入本地存储，它们不会访问网络，并且结构化的 `AiErrorEnvelope` 响应不会泄露堆栈跟踪或文件系统路径。 具有破坏性的 CLI 命令（`restore`、`rebuild index`、`compensate`、`backup --force-overwrite`）需要显式的 `--yes` 参数，并且需要在 TTY 上进行交互式确认。

完整的威胁模型，包括涉及的数据、未涉及的数据、所需的权限、各个方面的安全态势以及跟踪的残留问题，都记录在
[`SECURITY.md`](SECURITY.md) 中。

## 文档

请参阅 [`docs/README.md`](docs/README.md)，以获取完整的文档目录（从这里开始 / 参考 / 开发历史）。 重点包括：

- [快速入门](docs/quickstart.md) — 5分钟快速上手指南
- [手册](docs/handbook.md) — 官方操作指南 + 开发者指南
- [SDK](docs/sdk.md) / [命令行工具](docs/cli.md) / [MCP](docs/mcp.md) — 接口参考
- [策略与编辑](docs/policy-and-redaction.md) — 核心概念，能力，策略，安全区域
- [操作](docs/operations.md) — 诊断，验证，重新构建，备份，恢复
- [操作手册](docs/runbooks/README.md) — 每个错误类型对应一个操作手册
- [发布准备](docs/release-readiness.md) — 发布流程 + 已知问题和常见错误

## 许可证

MIT
