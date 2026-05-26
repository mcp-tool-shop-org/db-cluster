/**
 * Health assessment — builds ClusterHealth from individual store checks.
 */

import type { ClusterHealth, HealthCheck, HealthStatus } from '../types/health.js';

export function buildClusterHealth(checks: HealthCheck[]): ClusterHealth {
    const errors = checks.filter((c) => c.severity === 'error').length;
    const warnings = checks.filter((c) => c.severity === 'warning').length;
    const healthy = checks.filter((c) => c.status === 'healthy').length;
    const degraded = checks.filter((c) => c.status === 'degraded' || c.status === 'stale').length;

    let status: HealthStatus = 'healthy';
    if (errors > 0) {
        const hasCorrupt = checks.some((c) => c.status === 'corrupt');
        const hasMissing = checks.some((c) => c.status === 'missing');
        const hasUnreachable = checks.some((c) => c.status === 'unreachable');
        status = hasCorrupt ? 'corrupt' : hasUnreachable ? 'unreachable' : hasMissing ? 'missing' : 'degraded';
    } else if (warnings > 0 || degraded > 0) {
        status = 'degraded';
    }

    return {
        status,
        checkedAt: new Date().toISOString(),
        checks,
        summary: {
            total: checks.length,
            healthy,
            degraded,
            errors,
            warnings,
        },
    };
}

export function worstStatus(statuses: HealthStatus[]): HealthStatus {
    const priority: HealthStatus[] = ['corrupt', 'unreachable', 'missing', 'stale', 'degraded', 'unverified', 'healthy'];
    for (const s of priority) {
        if (statuses.includes(s)) return s;
    }
    return 'healthy';
}
