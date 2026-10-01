# db-cluster: how it works

Mapped at 2026-10-01 from commit 193d70c by Atlas 1.24.0.

## What this is

13 parts, mostly TypeScript (291 files), JavaScript (17), CSS (2), Astro (1) and HTML (1). Work enters through 9 doors; CI and Release each reach 5 parts, and CI is followed because a pull request goes through it. It publishes to npm and a container image. It deploys a site to GitHub Pages. People run db-cluster and db-cluster-mcp. People import @mcptoolshop/db-cluster.

## What changed since 2026-10-01 (d96918c)

- CI now also runs test/coverage-adapters-factory.test.ts, test/coverage-adapters-local-artifact.test.ts, test/coverage-adapters-local-ledger-recovery.test.ts and 29 more.
- Release Gate now also runs test/coverage-adapters-factory.test.ts, test/coverage-adapters-local-artifact.test.ts, test/coverage-adapters-local-ledger-recovery.test.ts and 29 more.
- Release now also runs test/coverage-adapters-factory.test.ts, test/coverage-adapters-local-artifact.test.ts, test/coverage-adapters-local-ledger-recovery.test.ts and 29 more.
- CHANGELOG.md is now also read by test/coverage-sdk-repo-knowledge-ingest.test.ts.
- README.md is now also read by test/coverage-sdk-repo-knowledge-ingest.test.ts.
- examples/dogfood-project-memory/.db-cluster is now also read by test/coverage-scripts-dashboard-snapshot.test.ts.
- And 3 more new writers and readers of places.
- 32 files added and 3 changed content, across 3 parts.

## What comes in

1. **CI.** On a pull request; on a push; or by hand. Runs scripts/merge-child-coverage.mjs, test/actor-required-regression.test.ts, test/adapters.test.ts and 158 more; builds src/; checks examples/.
2. **Release.** When a tag matching `v*` is pushed. Runs test/actor-required-regression.test.ts, test/adapters.test.ts, test/backend-env-surfaces.test.ts and 157 more; builds src/; checks examples/.
3. **Release Gate.** On a push to main; when a tag matching `v*` is pushed; or by hand. Runs scripts/completeness-checks.mjs, scripts/doc-drift.mjs, scripts/jsdoc-gate.mjs and 162 more; builds src/.
4. **Smoke Install.** On a pull request touching 1 path; when a tag matching `v*` is pushed; or by hand. Runs scripts/smoke-install.mjs; builds src/.
5. **Docker Publish.** When a tag matching `v*` is pushed; or by hand. Runs src/cli.ts; builds src/; packs LICENSE, README.md, docs/ and 3 more into an image.
6. **Deploy site to GitHub Pages.** On a pull request to main touching 2 paths; on a push to main touching 2 paths; or by hand. Runs site/astro.config.mjs and site/src/.
7. **@mcptoolshop/db-cluster** (the package people import). Loads src/index.ts, src/mcp/index.ts, src/policy/index.ts and 3 more.
8. **db-cluster** (a command people run). Runs src/cli.ts.
9. **db-cluster-mcp** (a command people run). Runs src/mcp/server.ts.

## What happens through CI

1. The workflow runs scripts/merge-child-coverage.mjs in scripts and 160 files in test; it builds src/ in src; it checks examples/ in examples.
2. That reaches dashboard (1 file).
3. It writes to examples/dogfood-project-memory/.db-cluster, which is not tracked.
4. It uploads coverage to Codecov.

## Who reads the results

CI writes only to examples/dogfood-project-memory/.db-cluster, which is not tracked.

## The other doors

**Release** runs test/actor-required-regression.test.ts, test/adapters.test.ts, test/backend-env-surfaces.test.ts and 157 more, builds src/, checks examples/, reaches dashboard and scripts, writes to examples/dogfood-project-memory/.db-cluster, which is not tracked, publishes to npm, and creates a GitHub release.

**Release Gate** runs scripts/completeness-checks.mjs, scripts/doc-drift.mjs, scripts/jsdoc-gate.mjs and 162 more, builds src/, reaches dashboard, and writes to .doc-drift-extract/, .release-gate-output/ and examples/dogfood-project-memory/.db-cluster, which are not tracked.

**Smoke Install** runs scripts/smoke-install.mjs and builds src/.

**Docker Publish** runs src/cli.ts, builds src/, packs LICENSE, README.md, docs/ and 3 more into an image, writes to examples/dogfood-project-memory/.db-cluster, which is not tracked, and publishes a container image.

**Deploy site to GitHub Pages** runs site/astro.config.mjs and site/src/, and deploys the site on a push to main or by hand.

**@mcptoolshop/db-cluster** (the package people import) loads src/index.ts, src/mcp/index.ts, src/policy/index.ts and 3 more, and writes to examples/dogfood-project-memory/.db-cluster, which is not tracked.

**db-cluster** (a command people run) runs src/cli.ts and writes to examples/dogfood-project-memory/.db-cluster, which is not tracked.

**db-cluster-mcp** (a command people run) runs src/mcp/server.ts and writes to examples/dogfood-project-memory/.db-cluster, which is not tracked.

## What breaks what

- **src** is imported by 1 part (scripts), and by 1 more only from tests, is run as a child process by 1 part (scripts), and sits on the path of 8 doors.
- **scripts** is imported by 1 part (the repository root), and by 1 more only from tests; it sits on the path of 4 doors.
- **test** is run as a child process by 1 part (scripts) and sits on the path of 3 doors.
- **dashboard** is imported only from tests, by 1 part (test), and sits on the path of 3 doors.
- **examples** is imported by no other part and sits on the path of 2 doors.

## What tends to change together

- **src/mcp/server.ts** and **src/sdk/cluster-sdk.ts** changed together in 7 of 9 commits, inside the src part.
- **scripts/completeness-checks.mjs** and **src/mcp/server.ts** changed together in 5 of 9 commits, and the scripts part imports the src part.
- **src/kernel/policy-enforced-kernel.ts** and **src/mcp/server.ts** changed together in 5 of 10 commits, inside the src part.
- **src/kernel/policy-enforced-kernel.ts** and **src/sdk/cluster-sdk.ts** changed together in 5 of 10 commits, inside the src part.

Confidence is low: fewer than 25 source files reach 10 revisions in the window.

Window: 180 days; a pair counts from 3 shared commits, since 2 source files reach 10 revisions; the floor rises to 10 when 25 do.

## What no test touches

- **examples** is imported by no test.

## Written but never read

No place this map can see is written, so none goes unread.

## Helpers that look duplicated

No two parts export a helper that looks alike.

## Generated, never hand-edited

Nothing in this repository writes to a tracked place this map can see.

## Hand-authored

People write .github/, .stage-b-amend/, .stage-b-audit/, .verifier-outputs-b1/, .verifier-outputs/, docs/, the repository root and site/; 5 writes with paths built at run time may land here.

## Where to start

.github/workflows/ci.yml → src/index.ts → src/types/evidence-bundle.ts → src/types/entity.ts

Read those in order to follow one pull request end to end.

## What this map cannot see

- 17 imports could not be resolved: `dashboard/lib/apply-redaction.d.ts` imports `../../dist/dashboard/dashboard-model.js`, which a build generates; `examples/agent-safe-app-db/index.ts` imports `@mcptoolshop/db-cluster/policy`, which a build generates, twice; `examples/agent-safe-app-db/index.ts` imports `@mcptoolshop/db-cluster/sdk`, which a build generates; and 13 more.
- 5 writes and 14 reads use paths built at run time and are not named here.
- 7 writes go to places this repository does not track, so they are not listed as generated.
- 50 writes and 103 reads go to a path their caller passes, not to this repository.
- 6 writes and 3 reads go to a temporary directory, not to this repository.
- 2 reads go to the directory the command is run in, not to this repository.
- 1 read goes to the directory the command is run in (.db-cluster) or a path its caller passes, not to this repository.
- 1 write goes to a temporary directory or a path its caller passes, not to this repository.
- 1 command is built at run time and not followed, and it is in tests.
- Statistics confidence is low: fewer than 25 source files reach 10 revisions in the window.

Regenerate with `npx --yes @dogfood-lab/atlas map`.
