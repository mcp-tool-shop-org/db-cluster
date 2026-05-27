import type { SiteConfig } from '@mcptoolshop/site-theme';

export const config: SiteConfig = {
  title: 'db-cluster',
  description: 'AI-native federated database cluster — specialized truth stores behaving as one governed substrate. Typed errors, mutation receipts, MCP + SDK + CLI surfaces.',
  logoBadge: 'DC',
  brandName: 'db-cluster',
  repoUrl: 'https://github.com/mcp-tool-shop-org/db-cluster',
  npmUrl: 'https://www.npmjs.com/package/db-cluster',
  footerText: 'MIT Licensed — built by <a href="https://mcp-tool-shop.github.io/" style="color:var(--color-muted);text-decoration:underline">MCP Tool Shop</a>',

  hero: {
    badge: 'v1.0.0 — shipping',
    headline: 'Federated truth.',
    headlineAccent: 'Governed substrate.',
    description: 'Four specialized stores (canonical, artifact, index, ledger) behaving as one cluster. Typed errors with remediation hints. Mutation receipts on every write. MCP + SDK + CLI surfaces with policy enforcement and redaction.',
    primaryCta: { href: 'https://github.com/mcp-tool-shop-org/db-cluster', label: 'View on GitHub' },
    secondaryCta: { href: 'handbook/', label: 'Read the Handbook' },
    previews: [
      { label: 'Install', code: 'npm install @mcptoolshop/db-cluster' },
      { label: 'Initialize', code: 'npx @mcptoolshop/db-cluster init' },
      { label: 'Retrieve', code: 'npx @mcptoolshop/db-cluster retrieve "your query"' },
    ],
  },

  sections: [
    {
      kind: 'features',
      id: 'features',
      title: 'Why db-cluster',
      subtitle: 'Four guarantees the model can rely on.',
      features: [
        {
          title: 'Federated truth',
          desc: 'Four stores — canonical, artifact, index, ledger — each owning its native truth shape. The kernel routes; the cluster owns. Indexes are derivative and rebuildable from owned stores.',
        },
        {
          title: 'Typed errors with remediation',
          desc: 'Every ClusterError subclass carries a `code`, `retryable`, and a `remediationHint`. AI agents branch on the code. Operators see "→ try: <command>" in the CLI. CLI exit codes map sysexits.h (65/70/77/78).',
        },
        {
          title: 'Mutation receipts everywhere',
          desc: 'propose → validate → approve → commit → (compensate). Every commit emits a content-addressable receipt. The ledger is append-only. Nothing mutates without a receipt.',
        },
        {
          title: 'MCP-native, AI-safe',
          desc: '16 MCP tools with safety annotations (readOnlyHint / destructiveHint / requiresApprovalHint). Structured AiErrorEnvelope responses, never raw stacks. PolicyEnforcedKernel is the only exported entry; ClusterKernel is intentionally not on the public surface.',
        },
      ],
    },
    {
      kind: 'code-cards',
      id: 'quickstart',
      title: 'Quickstart',
      cards: [
        {
          title: 'Install',
          code: 'npm install @mcptoolshop/db-cluster',
        },
        {
          title: 'Initialize and ingest',
          code: 'npx @mcptoolshop/db-cluster init\nnpx @mcptoolshop/db-cluster ingest ./evidence.md\nnpx @mcptoolshop/db-cluster retrieve "what we know about X"',
        },
        {
          title: 'Programmatic SDK',
          code: "import { ClusterSDK } from '@mcptoolshop/db-cluster/sdk';\n\nconst sdk = new ClusterSDK({ clusterDir: './.db-cluster' });\nconst bundle = await sdk.retrieveBundle('your query');\nconsole.log(bundle.confidenceBoundaries);",
        },
        {
          title: 'MCP server (for AI agents)',
          code: '// .mcp.json\n{\n  "mcpServers": {\n    "db-cluster": { "command": "npx", "args": ["db-cluster-mcp"] }\n  }\n}',
        },
      ],
    },
  ],
};
