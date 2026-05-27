/**
 * Type declarations for dashboard/lib/apply-redaction.js so vitest / TS
 * callers (tests) get full typing on the shared redaction helper.
 *
 * The JS implementation is the source of truth (also loaded by the browser
 * dashboard); this only describes its shape.
 */
import type { DashboardObject } from '../../src/dashboard/dashboard-model.js';

export interface PolicyView {
    principal: string;
    trustZone: string;
    visible: string[];
    redacted: string[];
}

export function applyRedaction<T extends DashboardObject>(
    dashObj: T,
    policyView: PolicyView,
): T;
