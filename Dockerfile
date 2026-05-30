# syntax=docker/dockerfile:1.7

# === Build stage ===
FROM node:22-alpine AS builder
WORKDIR /app

# Install build dependencies. `--ignore-scripts` skips devDep postinstall
# hooks like `@ast-grep/cli`'s native-binary fetch — that package only ships
# glibc binaries, so its postinstall fails on Alpine (musl). The dev tooling
# we actually need at build time (`tsc`, `vitest`) doesn't rely on postinstall
# side effects, and `@ast-grep/cli` itself is pruned by the `npm prune` below
# before anything reaches the runtime stage.
#
# NOTE (sqlite backend): `better-sqlite3` is an OPTIONAL dependency with a
# native binding, and `--ignore-scripts` skips its prebuilt-binary install — so
# the sqlite backend is NOT available in this image by design. The default
# local (JSON) and postgres backends need no native build and work as-is. To
# build an image WITH the sqlite backend, install build-base/python3 and run
# `npm rebuild better-sqlite3` (musl prebuilts permitting) in the build stage;
# the lazy driver load means this image otherwise runs fine without it.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source + build config
COPY tsconfig.json ./
COPY src/ ./src/

# Compile to dist/
RUN npm run build

# Trim to production deps for the runtime stage
RUN npm prune --omit=dev


# === Runtime stage ===
FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/mcp-tool-shop-org/db-cluster"
LABEL org.opencontainers.image.description="AI-native federated database cluster — CLI + MCP server. Specialized truth stores behaving as one governed substrate (typed errors, mutation receipts, policy-enforced surfaces)."
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.title="db-cluster"
LABEL org.opencontainers.image.url="https://mcp-tool-shop-org.github.io/db-cluster/"
LABEL org.opencontainers.image.documentation="https://mcp-tool-shop-org.github.io/db-cluster/handbook/"

WORKDIR /app

# Copy the production-pruned artifact tree
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/package.json ./
COPY README.md LICENSE ./
COPY docs/ ./docs/

# Make both bins available on PATH (db-cluster, db-cluster-mcp)
RUN npm install -g --no-save .

ENV NODE_ENV=production

# Cluster files persist under /workspace; operators mount a volume here.
WORKDIR /workspace

# Default: print CLI help. Run MCP server with: `docker run -i <image> db-cluster-mcp`.
ENTRYPOINT ["db-cluster"]
CMD ["--help"]
