# Runbook: Postgres adapter unreachable / degraded

Recovery procedure when the Postgres canonical adapter is unreachable, in degraded mode, or has migration drift. Applies only when `DB_CLUSTER_CANONICAL_BACKEND=postgres` is set; clusters using local filesystem canonical store are unaffected.

## Symptom

Any of the following:

- `db-cluster doctor` reports the canonical store in `unreachable` status.
- `db-cluster doctor` reports `connection_pool_idle_error` or `pool_acquire_timeout` in checks.
- `db-cluster migration-status` returns non-zero / reports missing tables.
- `db-cluster verify-schema` reports column drift.
- Operator-facing logs include `PoolClient.connect timeout` or `connection refused`.
- A long-idle cluster suddenly fails on the next write (idle-client RST — STORES-B-006 mitigation handles this but may surface as `connection terminated unexpectedly`).

## Cause

The Postgres canonical backend is opt-in. When it's the backend, three classes of failure can happen:

1. **Network unreachable** — `connection refused`, DNS failure, firewall, Postgres process down.
2. **Schema drift** — the cluster was upgraded but `db-cluster stores migrate` was never run; OR a different db-cluster version ran migrations and the live version expects different columns.
3. **Pool exhaustion / idle-client RST** — the `pg.Pool` is unable to acquire a connection; previously-idle clients were forcibly closed by Postgres or by a network middlebox.

Wave B1-Amend (STORES-B-006) attached a `pool.on('error', ...)` handler so an idle-client RST no longer crashes the process. But the underlying connection still has to be re-established.

## Verify

```bash
# 1. Backend configuration — confirm Postgres is actually configured.
echo "$DB_CLUSTER_CANONICAL_BACKEND"
echo "$DB_CLUSTER_POSTGRES_URL"  # mask the password before sharing!

# 2. Reachability — does the Postgres process answer at all?
psql "$DB_CLUSTER_POSTGRES_URL" -c "SELECT 1;"

# 3. Schema state.
db-cluster migration-status --json
db-cluster verify-schema --json

# 4. Pool health — try a simple read through the kernel.
db-cluster doctor --json | jq '.checks[] | select(.store == "canonical")'
```

## Recover

### Path 1 — Network unreachable

```bash
# 1. Confirm the Postgres process is up.
psql "$DB_CLUSTER_POSTGRES_URL" -c "SELECT version();"

# 2. If psql also fails, fix Postgres-side:
#    - Confirm host/port reachable: nc -zv <host> <port>
#    - Check the Postgres process is running on the server.
#    - Check the cluster's pg_hba.conf for connection rules.
#    - Check the cluster's listen_addresses postgresql.conf setting.

# 3. Once psql works, db-cluster recovers automatically:
db-cluster doctor
```

### Path 2 — Schema drift

```bash
# 1. Confirm what's drifted.
db-cluster migration-status --json
db-cluster verify-schema --json

# 2. Run pending migrations.
db-cluster stores migrate

# 3. Re-verify.
db-cluster migration-status
db-cluster verify-schema
db-cluster doctor
```

Note (v0.1.0 caveat): the applied_migrations registry is deferred to v0.2. `db-cluster stores migrate` currently re-runs the idempotent migration. If you need to track applied migrations across versions, hold off on the Postgres canonical backend until v0.2 ships the registry, or maintain version-pinning operationally.

### Path 3 — Pool exhaustion / idle-client RST

The Wave B1-Amend `pool.on('error', ...)` handler logs the error to stderr instead of crashing. New connections will be created on the next acquire.

```bash
# 1. Check operator-side logs for the pool.on('error') stderr message.

# 2. Run doctor — confirms the pool re-establishes.
db-cluster doctor

# 3. If pool exhaustion is chronic, increase the Postgres-side max_connections
#    OR reduce concurrent db-cluster processes against the same backend.

# 4. For idle-client RST root cause, check the network middlebox (typically
#    a corporate firewall enforcing a connection-idle timeout shorter than
#    Postgres's idle_in_transaction_session_timeout).
```

### Path 4 — SSL / TLS

> **db-cluster does not configure SSL/TLS for the Postgres connection in v1.0.0.**
> There is no `DB_CLUSTER_POSTGRES_SSL` variable — earlier docs claimed one;
> that claim is retracted. Enforce TLS at the connection-string level (the `pg`
> driver honours `sslmode`), with a TLS-terminating proxy, or on a private
> network. Driver-managed `ssl` config is planned for a future release.

```bash
# If your Postgres host requires (or you want) TLS, put it in the URL itself —
# the pg driver honours sslmode without any db-cluster-specific knob:
export DB_CLUSTER_POSTGRES_URL='postgres://user:pass@host:5432/db?sslmode=require'

# Self-signed / dev certs (NOT for production):
export DB_CLUSTER_POSTGRES_URL='postgres://user:pass@host:5432/db?sslmode=no-verify'

# Re-test.
db-cluster doctor
```

## Escalate

Bail and contact support if:

- Migrations report success but `verify-schema` still reports drift.
- Pool errors recur every minute (chronic structural issue).
- Postgres-side logs show `db-cluster` queries the operator didn't initiate (concurrent writer corruption).

When escalating, attach:

- `db-cluster doctor --json` output.
- `db-cluster migration-status --json` output.
- `db-cluster verify-schema --json` output.
- The Postgres version (`SELECT version();`).
- The first 10 lines of the Postgres server log around the failure timestamp.
- The exact `DB_CLUSTER_POSTGRES_URL` shape (with password masked).

## Related

- `docs/handbook.md` §10.3 — Postgres canonical store setup.
- `docs/operations.md` — doctor/verify on physical backends.
- `CHANGELOG.md` Wave A3 — STORES-R2-002 importSnapshot ON CONFLICT.
- `CHANGELOG.md` Wave S2-A1 — EGRESS-001 SSL claim retraction + pool.on('error') at every Pool site.
