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
    /** Suggested CLI command to fix */
    suggestedCommand?: string;
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
