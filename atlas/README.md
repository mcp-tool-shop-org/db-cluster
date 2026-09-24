# db-cluster: how it works

Mapped at 2026-09-24 from commit f1d79e0.

## What this is

13 parts, mostly TypeScript (255 files). Work enters through 9 doors; the busiest is CI, which reaches 5 parts. It publishes to npm and a container image. People run db-cluster and db-cluster-mcp. People import @mcptoolshop/db-cluster.

## What changed since 2026-09-23 (2fb8e75)

- the repository root now imports scripts.
- CI now also runs test/actor-required-regression.test.ts, test/backend-env-surfaces.test.ts, test/exit-code-tables-regression.test.ts and 4 more.
- Deploy site to GitHub Pages now also starts on a pull request touching 2 paths.
- Release now also runs test/actor-required-regression.test.ts, test/backend-env-surfaces.test.ts, test/exit-code-tables-regression.test.ts and 4 more.
- test/ is now read by scripts/stryker-exclusions.mjs.
- test/wave-s2a1-contracts-regression.test.ts is now read by tsconfig.typetests.json.
- tsconfig.json is now also read by tsconfig.typetests.json.
- And 1 more new writer or reader of a place.
- 19 files added and 219 changed content, across 13 parts.

## What comes in

1. **CI.** On a pull request; on a push; or by hand. Runs test/actor-required-regression.test.ts, test/adapters.test.ts, test/backend-env-surfaces.test.ts and 121 more; checks examples/ and src/.
2. **Release.** When a tag matching `v*` is pushed. Runs test/actor-required-regression.test.ts, test/adapters.test.ts, test/backend-env-surfaces.test.ts and 121 more; checks examples/ and src/.
3. **Release Gate.** On a push to main; when a tag matching `v*` is pushed; or by hand. Runs scripts/release-gate.mjs; checks src/.
4. **Smoke Install.** On a pull request touching 1 path; when a tag matching `v*` is pushed; or by hand. Runs scripts/smoke-install.mjs; checks src/.
5. **Deploy site to GitHub Pages.** On a pull request touching 2 paths; on a push to main touching 2 paths; or by hand. Runs site/astro.config.mjs and site/src/.
6. **Docker Publish.** When a tag matching `v*` is pushed; or by hand. Runs no file this map can see.
7. **@mcptoolshop/db-cluster** (the package people import). Loads src/index.ts.
8. **db-cluster** (a command people run). Runs src/cli.ts.
9. **db-cluster-mcp** (a command people run). Runs src/mcp/server.ts.

## What happens through CI

1. The workflow runs 124 files in test; it checks examples/ in examples and src/ in src.
2. That reaches dashboard (1 file) and scripts (5 files).

## Who reads the results

CI writes nothing this map can see.

## The other doors

**Release** runs test/actor-required-regression.test.ts, test/adapters.test.ts, test/backend-env-surfaces.test.ts and 121 more, checks examples/ and src/, reaches dashboard and scripts, publishes to npm, and creates a GitHub release.

**Release Gate** runs scripts/release-gate.mjs and checks src/.

**Smoke Install** runs scripts/smoke-install.mjs and checks src/.

**Deploy site to GitHub Pages** runs site/astro.config.mjs and site/src/, and deploys the site.

**Docker Publish** runs no file this map can see and publishes a container image.

**@mcptoolshop/db-cluster** (the package people import) loads src/index.ts.

**db-cluster** (a command people run) runs src/cli.ts.

**db-cluster-mcp** (a command people run) runs src/mcp/server.ts.

## What breaks what

- **src** is imported by 3 parts (dashboard, examples, scripts), and by 1 more only from tests; it sits on the path of 7 doors.
- **scripts** is imported by 1 part (the repository root), and by 1 more only from tests; it sits on the path of 4 doors.
- **dashboard** is imported only from tests, by 1 part (test), and sits on the path of 2 doors.
- **examples** is imported by no other part and sits on the path of 2 doors.
- **test** is imported by no other part and sits on the path of 2 doors.

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

People write .github/, .stage-b-amend/, .stage-b-audit/, .verifier-outputs-b1/, .verifier-outputs/, docs/, the repository root and site/; 45 writes with paths built at run time may land here.

## Where to start

.github/workflows/ci.yml → test/actor-required-regression.test.ts → scripts/dashboard-snapshot.ts

Read those in order to follow one pull request end to end.

## What this map cannot see

- 1 import site could not be resolved.
- 3 files use syntax the parser cannot read, so what they import is not known: 2 in test (a NUL character inside a string in 1 and other syntax in 1), 1 in src (an import type followed by `[]`).
- 45 writes and 63 reads use paths built at run time and are not named here.
- 2 writes go to places this repository does not track, so they are not listed as generated.
- 2 writes and 1 read go to the directory the command is run in or the home directory, not to this repository.
- 78 commands are built at run time and not followed, 74 of them in tests.
- Statistics confidence is low: fewer than 25 source files reach 10 revisions in the window.

Regenerate with `npx --yes @dogfood-lab/atlas map`.
