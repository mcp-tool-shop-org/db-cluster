import { describe, it, expect } from 'vitest';
import {
    evaluatePolicy,
    explainPolicyDecision,
    sortPoliciesByPriority,
    matchPolicy,
    checkVisibility,
} from '../src/policy/index.js';
import type { Policy, Principal, TrustZone, VisibilityRule } from '../src/types/policy.js';

// ─── Test fixtures ─────────────────────────────────────────────────────────

const admin: Principal = {
    id: 'admin-1',
    name: 'Admin',
    roles: ['cluster-admin'],
    trustZone: 'internal',
};

const observer: Principal = {
    id: 'observer-1',
    name: 'Read-Only Agent',
    roles: ['observer'],
    trustZone: 'ai-facing',
};

const proposer: Principal = {
    id: 'proposer-1',
    name: 'AI Agent',
    roles: ['proposer'],
    trustZone: 'ai-facing',
};

const nobody: Principal = {
    id: 'nobody-1',
    name: 'Unknown Actor',
    roles: [],
    trustZone: 'external',
};

const policies: Policy[] = [
    {
        id: 'admin-full',
        name: 'Admin Full Access',
        priority: 10,
        match: { principals: ['cluster-admin'] },
        decision: 'allow',
        reason: 'Admin has full access.',
    },
    {
        id: 'observer-read',
        name: 'Observer Read',
        priority: 20,
        match: {
            principals: ['observer'],
            capabilities: ['read_owner_truth', 'read_derivative', 'discover_existence', 'trace_provenance', 'read_receipts', 'explain_retrieval'],
        },
        decision: 'allow',
        reason: 'Observer can read.',
    },
    {
        id: 'proposer-read-propose',
        name: 'Proposer Read and Propose',
        priority: 20,
        match: {
            principals: ['proposer'],
            capabilities: ['read_owner_truth', 'read_derivative', 'discover_existence', 'trace_provenance', 'propose_mutation', 'validate_command', 'read_receipts', 'explain_retrieval'],
        },
        decision: 'allow',
        reason: 'Proposer can read and propose.',
    },
    {
        id: 'proposer-deny-commit',
        name: 'Proposer Cannot Commit',
        priority: 15,
        match: {
            principals: ['proposer'],
            capabilities: ['commit_command', 'approve_command', 'compensate_command'],
        },
        decision: 'deny',
        reason: 'Proposers cannot commit.',
    },
    {
        id: 'canonical-only',
        name: 'Canonical Store Only',
        priority: 25,
        match: {
            principals: ['canonical-reader'],
            capabilities: ['read_owner_truth'],
            stores: ['canonical'],
        },
        decision: 'allow',
        reason: 'Limited to canonical store.',
    },
    {
        id: 'uri-scoped',
        name: 'URI Prefix Scoped',
        priority: 25,
        match: {
            principals: ['scoped-reader'],
            capabilities: ['read_owner_truth'],
            uriPatterns: ['cluster://canonical/project-a/'],
        },
        decision: 'allow',
        reason: 'Limited to project-a URIs.',
    },
    {
        id: 'create-only',
        name: 'Create Entity Only',
        priority: 25,
        match: {
            principals: ['creator'],
            capabilities: ['commit_command'],
            commandVerbs: ['create_entity'],
        },
        decision: 'allow',
        reason: 'Can only commit create_entity commands.',
    },
    {
        id: 'redacted-read',
        name: 'Redacted Artifact Access',
        priority: 30,
        match: {
            principals: ['redacted-reader'],
            capabilities: ['read_owner_truth'],
            stores: ['artifact'],
        },
        decision: 'allow',
        reason: 'Can read artifacts, but content is redacted.',
        redaction: {
            id: 'strip-content',
            target: 'artifact_content',
            behavior: 'strip',
            reason: 'Artifact content not authorized for this principal.',
        },
    },
];

const trustZones: TrustZone[] = [
    {
        id: 'internal',
        name: 'Internal',
        defaultCapabilities: ['read_owner_truth', 'read_derivative', 'trace_provenance'],
        defaultScope: { stores: ['*'] },
        approvalMode: 'auto',
        redactionRules: [],
        visibilityRules: [],
    },
    {
        id: 'ai-facing',
        name: 'AI-Facing',
        defaultCapabilities: ['read_derivative', 'discover_existence'],
        defaultScope: { stores: ['*'] },
        approvalMode: 'require_approval_for_writes',
        redactionRules: [],
        visibilityRules: [],
    },
    {
        id: 'external',
        name: 'External',
        defaultCapabilities: ['discover_existence'],
        defaultScope: { stores: ['index'] },
        approvalMode: 'require_approval',
        redactionRules: [],
        visibilityRules: [
            {
                id: 'hide-ledger',
                scope: { stores: ['ledger'] },
                existenceVisible: false,
                emitPlaceholder: false,
            },
        ],
    },
];

const visibilityRules: VisibilityRule[] = [
    {
        id: 'hide-restricted',
        scope: { stores: ['artifact'], kinds: ['restricted'] },
        existenceVisible: false,
        emitPlaceholder: true,
    },
    {
        id: 'show-canonical',
        scope: { stores: ['canonical'] },
        existenceVisible: true,
        emitPlaceholder: false,
    },
];

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Wave 2 — Policy Engine', () => {

    // ─── Proof 1: default deny ───────────────────────────────────────

    describe('Proof 1: default deny when no policy matches', () => {
        it('unknown principal with no matching policy gets denied', () => {
            const decision = evaluatePolicy(
                { principal: nobody, capability: 'read_owner_truth' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('deny');
            expect(decision.matchedPolicyId).toBe('__default_deny');
            expect(decision.reason).toContain('No matching policy');
        });

        it('empty policy set always denies', () => {
            const decision = evaluatePolicy(
                { principal: admin, capability: 'read_owner_truth' },
                { policies: [], trustZones },
            );
            expect(decision.decision).toBe('deny');
        });
    });

    // ─── Proof 2: explicit allow ─────────────────────────────────────

    describe('Proof 2: explicit allow grants capability', () => {
        it('admin gets allowed', () => {
            const decision = evaluatePolicy(
                { principal: admin, capability: 'commit_command' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
            expect(decision.matchedPolicyId).toBe('admin-full');
        });

        it('observer gets allowed for read', () => {
            const decision = evaluatePolicy(
                { principal: observer, capability: 'read_owner_truth' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
            expect(decision.matchedPolicyId).toBe('observer-read');
        });
    });

    // ─── Proof 3: explicit deny overrides allow ──────────────────────

    describe('Proof 3: explicit deny overrides allow at lower priority number', () => {
        it('proposer denied commit even though they have a broad allow', () => {
            const decision = evaluatePolicy(
                { principal: proposer, capability: 'commit_command' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('deny');
            expect(decision.matchedPolicyId).toBe('proposer-deny-commit');
            expect(decision.reason).toContain('cannot commit');
        });

        it('proposer denied approve', () => {
            const decision = evaluatePolicy(
                { principal: proposer, capability: 'approve_command' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('deny');
        });
    });

    // ─── Proof 4: higher-priority rule wins ──────────────────────────

    describe('Proof 4: higher-priority (lower number) rule wins', () => {
        it('priority 10 admin beats priority 20 observer', () => {
            // Admin has full access at p10; even if a p20 deny existed for "admin" it would lose
            const decision = evaluatePolicy(
                { principal: admin, capability: 'commit_command' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
            expect(decision.matchedPolicyId).toBe('admin-full');
        });

        it('deny at same priority wins over allow', () => {
            const samePriorityPolicies: Policy[] = [
                { id: 'allow-x', name: 'Allow', priority: 10, match: { principals: ['x'] }, decision: 'allow', reason: 'yes' },
                { id: 'deny-x', name: 'Deny', priority: 10, match: { principals: ['x'] }, decision: 'deny', reason: 'no' },
            ];
            const xPrincipal: Principal = { id: 'x', name: 'X', roles: ['x'], trustZone: 'internal' };
            const decision = evaluatePolicy(
                { principal: xPrincipal, capability: 'read_owner_truth' },
                { policies: samePriorityPolicies, trustZones },
            );
            expect(decision.decision).toBe('deny');
        });
    });

    // ─── Proof 5: scope limits by owner store ────────────────────────

    describe('Proof 5: scope limits by owner store', () => {
        it('canonical-reader allowed for canonical store', () => {
            const reader: Principal = { id: 'cr-1', name: 'CR', roles: ['canonical-reader'], trustZone: 'internal' };
            const decision = evaluatePolicy(
                { principal: reader, capability: 'read_owner_truth', ownerStore: 'canonical' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
        });

        it('canonical-reader denied for artifact store', () => {
            const reader: Principal = { id: 'cr-1', name: 'CR', roles: ['canonical-reader'], trustZone: 'internal' };
            const decision = evaluatePolicy(
                { principal: reader, capability: 'read_owner_truth', ownerStore: 'artifact' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('deny');
        });
    });

    // ─── Proof 6: scope limits by URI prefix ─────────────────────────

    describe('Proof 6: scope limits by URI prefix', () => {
        it('scoped-reader allowed for matching URI', () => {
            const reader: Principal = { id: 'sr-1', name: 'SR', roles: ['scoped-reader'], trustZone: 'internal' };
            const decision = evaluatePolicy(
                { principal: reader, capability: 'read_owner_truth', resourceUri: 'cluster://canonical/project-a/doc-1' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
        });

        it('scoped-reader denied for non-matching URI', () => {
            const reader: Principal = { id: 'sr-1', name: 'SR', roles: ['scoped-reader'], trustZone: 'internal' };
            const decision = evaluatePolicy(
                { principal: reader, capability: 'read_owner_truth', resourceUri: 'cluster://canonical/project-b/doc-1' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('deny');
        });
    });

    // ─── Proof 7: command verb conditions ────────────────────────────

    describe('Proof 7: command verb conditions work', () => {
        it('creator can commit create_entity', () => {
            const creator: Principal = { id: 'c-1', name: 'Creator', roles: ['creator'], trustZone: 'internal' };
            const decision = evaluatePolicy(
                { principal: creator, capability: 'commit_command', commandVerb: 'create_entity' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
        });

        it('creator cannot commit update_entity', () => {
            const creator: Principal = { id: 'c-1', name: 'Creator', roles: ['creator'], trustZone: 'internal' };
            const decision = evaluatePolicy(
                { principal: creator, capability: 'commit_command', commandVerb: 'update_entity' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('deny');
        });
    });

    // ─── Proof 8: trust zone requires approval ──────────────────────

    describe('Proof 8: trust zone can require approval for writes', () => {
        it('ai-facing zone adds approval requirement for commit', () => {
            // Admin is allowed commit, but in ai-facing zone needs approval
            const aiAdmin: Principal = { id: 'ai-admin', name: 'AI Admin', roles: ['cluster-admin'], trustZone: 'ai-facing' };
            const decision = evaluatePolicy(
                { principal: aiAdmin, capability: 'commit_command' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
            expect(decision.requiresApproval).toBe(true);
        });

        it('internal zone does not require approval', () => {
            const decision = evaluatePolicy(
                { principal: admin, capability: 'commit_command' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
            expect(decision.requiresApproval).toBe(false);
        });

        it('read operations do not trigger approval requirement', () => {
            const aiObserver: Principal = { id: 'ao-1', name: 'AI Obs', roles: ['observer'], trustZone: 'ai-facing' };
            const decision = evaluatePolicy(
                { principal: aiObserver, capability: 'read_owner_truth' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
            expect(decision.requiresApproval).toBe(false);
        });
    });

    // ─── Proof 9: redaction rule in decision ─────────────────────────

    describe('Proof 9: redaction rule appears in decision', () => {
        it('redacted-reader gets allow with redaction', () => {
            const reader: Principal = { id: 'rr-1', name: 'RR', roles: ['redacted-reader'], trustZone: 'internal' };
            const decision = evaluatePolicy(
                { principal: reader, capability: 'read_owner_truth', ownerStore: 'artifact' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
            expect(decision.redaction).toBeTruthy();
            expect(decision.redaction!.target).toBe('artifact_content');
            expect(decision.redaction!.behavior).toBe('strip');
        });

        it('admin gets allow without redaction', () => {
            const decision = evaluatePolicy(
                { principal: admin, capability: 'read_owner_truth', ownerStore: 'artifact' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('allow');
            expect(decision.redaction).toBeUndefined();
        });
    });

    // ─── Proof 10: visibility rule controls existence ────────────────

    describe('Proof 10: visibility rule controls existence disclosure', () => {
        it('restricted artifact scope is hidden with placeholder', () => {
            const vis = checkVisibility('cluster://artifact/secret-1', 'artifact', visibilityRules);
            expect(vis.existenceVisible).toBe(false);
            expect(vis.emitPlaceholder).toBe(true);
        });

        it('canonical scope is visible without placeholder', () => {
            const vis = checkVisibility('cluster://canonical/doc-1', 'canonical', visibilityRules);
            expect(vis.existenceVisible).toBe(true);
            expect(vis.emitPlaceholder).toBe(false);
        });

        it('unknown scope defaults to hidden', () => {
            const vis = checkVisibility('cluster://ledger/event-1', 'ledger', visibilityRules);
            expect(vis.existenceVisible).toBe(false);
            expect(vis.emitPlaceholder).toBe(false);
        });
    });

    // ─── Proof 11: role alone not enough outside scope ───────────────

    describe('Proof 11: role capability alone is not enough outside scope', () => {
        it('canonical-reader role does not grant access to artifact store', () => {
            const reader: Principal = { id: 'cr-2', name: 'CR2', roles: ['canonical-reader'], trustZone: 'internal' };
            const decision = evaluatePolicy(
                { principal: reader, capability: 'read_owner_truth', ownerStore: 'artifact' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('deny');
        });

        it('uri-scoped role does not grant access outside URI prefix', () => {
            const reader: Principal = { id: 'sr-2', name: 'SR2', roles: ['scoped-reader'], trustZone: 'internal' };
            const decision = evaluatePolicy(
                { principal: reader, capability: 'read_owner_truth', resourceUri: 'cluster://canonical/other/thing' },
                { policies, trustZones },
            );
            expect(decision.decision).toBe('deny');
        });
    });

    // ─── Proof 12: decision includes reason and matched policy ───────

    describe('Proof 12: decision includes reason and matched policy ID', () => {
        it('allow decision has policy ID and reason', () => {
            const decision = evaluatePolicy(
                { principal: admin, capability: 'read_owner_truth' },
                { policies, trustZones },
            );
            expect(decision.matchedPolicyId).toBe('admin-full');
            expect(decision.matchedPolicyName).toBe('Admin Full Access');
            expect(decision.reason).toBeTruthy();
            expect(decision.principalId).toBe('admin-1');
        });

        it('deny decision has policy ID and reason', () => {
            const decision = evaluatePolicy(
                { principal: proposer, capability: 'commit_command' },
                { policies, trustZones },
            );
            expect(decision.matchedPolicyId).toBe('proposer-deny-commit');
            expect(decision.matchedPolicyName).toBe('Proposer Cannot Commit');
            expect(decision.reason).toContain('cannot commit');
        });

        it('explainPolicyDecision produces readable output', () => {
            const decision = evaluatePolicy(
                { principal: proposer, capability: 'commit_command' },
                { policies, trustZones },
            );
            const explanation = explainPolicyDecision(decision);
            expect(explanation).toContain('DENY');
            expect(explanation).toContain('proposer-1');
            expect(explanation).toContain('commit_command');
            expect(explanation).toContain('Proposer Cannot Commit');
        });
    });

    // ─── Bonus: sortPoliciesByPriority ───────────────────────────────

    describe('sortPoliciesByPriority', () => {
        it('sorts by priority ascending', () => {
            const sorted = sortPoliciesByPriority(policies);
            for (let i = 1; i < sorted.length; i++) {
                expect(sorted[i].priority).toBeGreaterThanOrEqual(sorted[i - 1].priority);
            }
        });

        it('deny before allow at same priority', () => {
            const tied: Policy[] = [
                { id: 'a', name: 'A', priority: 5, match: {}, decision: 'allow', reason: '' },
                { id: 'b', name: 'B', priority: 5, match: {}, decision: 'deny', reason: '' },
            ];
            const sorted = sortPoliciesByPriority(tied);
            expect(sorted[0].decision).toBe('deny');
        });
    });

    // ─── Bonus: matchPolicy ──────────────────────────────────────────

    describe('matchPolicy', () => {
        it('empty match matches everything', () => {
            const policy: Policy = { id: 'x', name: 'X', priority: 1, match: {}, decision: 'allow', reason: '' };
            expect(matchPolicy({ principal: admin, capability: 'read_owner_truth' }, policy)).toBe(true);
            expect(matchPolicy({ principal: nobody, capability: 'commit_command' }, policy)).toBe(true);
        });

        it('principal mismatch rejects', () => {
            const policy: Policy = { id: 'x', name: 'X', priority: 1, match: { principals: ['only-me'] }, decision: 'allow', reason: '' };
            expect(matchPolicy({ principal: admin, capability: 'read_owner_truth' }, policy)).toBe(false);
        });
    });
});
