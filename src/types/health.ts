/**
 * Health types — cluster operational state model.
 *
 * Every component of the cluster has an inspectable health status.
 * Health is explicit, not inferred from absence of errors.
 */

export type HealthStatus =
    | 'healthy'
    | 'degraded'
    | 'stale'
    | 'missing'
    | 'corrupt'
    | 'unreachable'
    | 'unverified';

export interface HealthCheck {
    /** What was checked */
    name: string;
    /** Which store or subsystem */
    store: 'canonical' | 'artifact' | 'index' | 'ledger' | 'cluster' | 'policy' | 'migration';
    /** Current status */
    status: HealthStatus;
    /** Severity: error blocks operation, warning is degraded, info is advisory */
    severity: 'error' | 'warning' | 'info';
    /** Human-readable explanation */
    message: string;
    /** Specific resource URI if applicable */
    resourceUri?: string;
    /** Whether an automated repair is available */
    repairAvailable: boolean;
    /**
     * Suggested CLI command to fix the issue. Set whenever the check has a
     * concrete remediation path. Canonical operator-facing channel — the CLI
     * renders this as `→ fix: ${suggestedCommand}` and the MCP boundary
     * surfaces it under `_meta.suggestedCommand` for AI consumers. When the
     * remediation is not a single command (multi-step recovery, manual
     * inspection), populate {@link nextSteps} instead and leave this blank.
     */
    suggestedCommand?: string;
    /**
     * Operator-readable next-step strings for checks where the remediation is
     * a multi-step procedure rather than a single command (STORES-C-001).
     * Each entry is one short prose line. Empty/absent for healthy checks
     * and for checks that have a single concrete {@link suggestedCommand}.
     *
     * Example: a `mutation_orphaned` warning carries both `suggestedCommand`
     * (the inspection command to run first) AND `nextSteps` (the multi-step
     * recovery procedure once the operator has the orphan list).
     */
    nextSteps?: string[];
    /**
     * Optional human-readable detail block for checks that have additional
     * context beyond the one-line `message`. Surfaces under `--json` and may
     * be used by dashboards. Multi-line content is OK.
     */
    details?: string;
}

export interface ClusterHealth {
    /** Overall cluster status (worst of all checks) */
    status: HealthStatus;
    /** Timestamp of health check */
    checkedAt: string;
    /** Individual checks */
    checks: HealthCheck[];
    /** Summary counts */
    summary: {
        total: number;
        healthy: number;
        degraded: number;
        errors: number;
        warnings: number;
    };
}

export interface StoreHealth {
    store: string;
    backend: string;
    status: HealthStatus;
    reachable: boolean;
    recordCount?: number;
    message: string;
}
