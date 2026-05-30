<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.md">English</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**传统的数据库系统假定调用者会谨慎地、有条不紊地进行操作。而人工智能代理则不然。**

传统的存储系统会将为人工开发者编写的错误信息传递给代理，并在收到有效数据后立即执行，并返回查询涉及到的所有字段——因此，代理无法可靠地判断下一步该做什么，没有任何东西可以阻止提示注入攻击，敏感信息会直接进入上下文窗口。db-cluster正是针对这种不匹配问题而设计的：它是一种专门的“真值存储”，作为一个集群运行，并受到单一策略内核的控制，从而满足代理的需求——它提供带有明确下一步操作指示的类型化错误信息，提供可引用的证据集合，对所有读取路径进行审查，并采用“提出建议→批准→提交”的生命周期，以防止提示注入攻击悄无声息地破坏您的数据。默认情况下，它采用本地存储，在需要扩展时可以使用Postgres和SQLite，并且可以通过命令行界面、软件开发工具包和多云平台进行访问。

## 这适用于谁？

- **AI 代理**，它们需要可靠的检索、结构化的错误信息，以及一种不会让它们悄悄破坏状态的变更生命周期。
- **操作员**，他们运行图 + 溯源存储，并希望使用类型化的退出代码、诊断/验证工具、操作手册以及安全的备份/恢复功能。
- **开发人员**，他们构建基于集群的应用程序，并希望使用明确的公共 API、全新安装的测试、以及每个方法的 JSDoc + 示例。
- **仪表板查看者**，他们审计集群的“真相”——存储所有权、溯源血统、命令预览、内容屏蔽视图。

## 为什么使用 db-cluster？

- **带有 `remediationHint` 的类型化错误**——每个 `ClusterError` 子类都会回答“应该怎么做”，而不仅仅是“哪里出错”（CLI 退出代码 65/70/77/78 映射到类型化错误代码）。
- **AI 错误信息**——`{code, message, retryable, remediation_hint, context, next_valid_actions}` 模式；AI 代理可以根据 `code` 和 `retryable` 进行分支，而无需解析文本。
- **每次变更都有记录**——内容寻址；溯源图；从索引存储重建的契约。
- **带有安全注释的 MCP 服务器**——只读 / 暂存 / 审批 / 写入工具，每个工具都带有机器可读的 `readOnlyHint` / `destructiveHint` 标志。服务器默认设置为“面向 AI”的信任区域（内容屏蔽开启，不显示原始内容），并且 MCP 写入工具在命令获得“批准”之前拒绝提交。
- **默认强制执行策略**——包根工厂 `createSafeCluster()` 返回一个受策略控制的句柄（一个 `PolicyEnforcedKernel` + 只读操作，没有原始存储修改器）。只有通过显式的 `@mcptoolshop/db-cluster/unsafe` 逃生通道才能访问原始的、不受策略控制的存储。

## 快速入门（3 个步骤）

```bash
npx @mcptoolshop/db-cluster init                # 1. initialize .db-cluster/
npx @mcptoolshop/db-cluster ingest ./file.md    # 2. ingest an artifact
npx @mcptoolshop/db-cluster retrieve "query"    # 3. retrieve an evidence bundle
```

或者全局安装 + 直接使用 `db-cluster` 和 `db-cluster-mcp` 二进制文件：

```bash
npm install -g @mcptoolshop/db-cluster
db-cluster init
```

或者通过 Docker 运行（无需安装 Node）：

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/mcp-tool-shop-org/db-cluster:latest init
```

完整的完整路径：[`docs/quickstart.md`](docs/quickstart.md)（5 分钟）。

## 这是什么？

一个联邦数据库集群，其中：

- **规范存储**——实体、ID、稳定状态记录
- **工件存储**——原始文件、文档、源代码、生成的输出
- **索引存储**——可发现性、全文（排序）查找、元数据搜索
- **事件/溯源账本**——操作、链接、变更、记录、血统

内核进行路由。索引进行发现。集群拥有真相。

“联邦”意味着专门的“真相存储”，它们可以在不同的后端上运行；Postgres 后端目前仅适用于“规范存储”——工件、索引和账本存储运行在本地/SQLite 后端上。

## 这不是什么？

- AI 数据库助手
- 跨多个存储的索引
- 治理中间件
- 带有插件的向量数据库
- 代理内存层

## 架构规则

1. 每个事实都有一个所有者存储
2. 索引是派生的——可以删除并从所有者存储重建
3. AI 绝不会直接修改原始状态
4. 每个答案都可追溯到原始真相
5. 每个变更都跨越一个类型化的命令边界
6. 工件真相默认是不可变的——更正会创建版本，而不是覆盖
7. 内核进行路由；集群拥有

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

有关完整的 CLI 参考（包括类型化错误退出代码表），请参见 [`docs/cli.md`](docs/cli.md)。

## 先决条件

- Node.js 20+（通过 `package.json` 中的 `engines.node` 强制执行）
- npm

## 信任模型

db-cluster 在**本地**运行。它读取 + 写入您指向的目录中的 `.db-cluster/` 目录，并读取您传递给 `ingest` 的工件。默认情况下，**没有网络出口**，并且**没有遥测数据**。唯一的可选外部连接是到 Postgres 主机，如果您设置了 `DB_CLUSTER_POSTGRES_URL`。**db-cluster 在 v1.0.0 中不会为该连接配置 SSL/TLS**——除非您的连接字符串强制执行（例如 `sslmode=require`，`pg` 驱动程序会遵守），或者使用 TLS 终止代理，或者使用专用网络，否则传输是纯文本。驱动程序管理的 TLS 配置计划用于未来的版本。

MCP 服务器工具仅读取 + 写入本地存储——它们永远不会到达网络，并且结构化的 `AiErrorEnvelope` 响应绝不会泄露堆栈跟踪或文件系统路径。**MCP 服务器默认设置为“面向 AI”的信任区域，内容屏蔽已开启：**工件内容和敏感实体属性默认在边界处被删除，并且没有 MCP 工具会返回原始工件字节。需要特权（“内部”/“集群管理员”）权限的操作员必须通过环境变量显式选择加入（暂定为 `DB_CLUSTER_MCP_ALLOW_PRIVILEGED`；参见 [`docs/mcp.md`](docs/mcp.md)）。**MCP 写入工具强制执行批准：**`cluster_commit_mutation` 和 `cluster_compensate_mutation` 除非命令处于“已批准”状态，否则拒绝写入——调用者必须首先调用 `cluster_approve_mutation`，并且拒绝将是一个结构化的 `AiErrorEnvelope`，而不是部分写入。（受信任的进程内 SDK 调用不受影响——此网关仅适用于 MCP 表面。）破坏性 CLI 命令（`restore`、`rebuild index`、`compensate`、`backup --force-overwrite`）需要显式的 `--yes` 标志，以及在 TTY 上的交互式确认。

完整的威胁模型——涉及的数据、未涉及的数据、所需的权限、每个表面的姿态以及跟踪的残留物——位于 [`SECURITY.md`](SECURITY.md)。

## 文档

请参阅 [`docs/README.md`](docs/README.md) 以获取完整的文档地图（从这里开始/参考/开发阶段历史）。重点内容：

- [快速入门](docs/quickstart.md) — 5 分钟快速上手指南
- [手册](docs/handbook.md) — 标准操作指南 + 开发者指南
- [架构](docs/architecture.md) — 联邦式真值模型 + 七大架构原则
- [存储合约](docs/store-contracts.md) — 每个存储单元所拥有的内容和保证
- [变更法则](docs/mutation-law.md) / [溯源图](docs/provenance-graphs.md) — 安全写入生命周期和溯源跟踪
- [SDK](docs/sdk.md) / [CLI](docs/cli.md) / [MCP](docs/mcp.md) — 表面参考
- [策略和审查](docs/policy-and-redaction.md) — 主体、能力、策略、TrustZone
- [操作](docs/operations.md) — 诊断、验证、重建、备份、恢复
- [操作手册](docs/runbooks/README.md) — 每种类型的错误都有一个操作手册
- [发布准备](docs/release-readiness.md) — 发布流程 + 已知的潜在问题

## 许可

MIT
