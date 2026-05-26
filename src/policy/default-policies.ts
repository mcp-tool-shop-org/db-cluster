import type { Policy, TrustZone, VisibilityRule } from '../types/policy.js';

/**
 * Default policies for a freshly initialized cluster.
 *
 * These establish baseline security posture:
 * - Default deny for everything
 * - A "cluster-admin" role gets full access
 * - An "observer" role gets read-only access
 * - An "proposer" role can propose but not commit
 */

export const DEFAULT_POLICIES: Policy[] = [
    {
        id: 'admin-full-access',
        name: 'Cluster Admin Full Access',
        priority: 10,
        match: { principals: ['cluster-admin'] },
        decision: 'allow',
        reason: 'Cluster admin has unrestricted access.',
    },
    {
        id: 'observer-read',
        name: 'Observer Read Access',
        priority: 20,
        match: {
            principals: ['observer'],
            capabilities: [
                'discover_existence',
                'read_owner_truth',
                'read_derivative',
                'trace_provenance',
                'read_receipts',
                'read_command',
                'explain_retrieval',
            ],
        },
        decision: 'allow',
        reason: 'Observer role grants read-only cluster access.',
    },
    {
        id: 'proposer-propose',
        name: 'Proposer Can Propose',
        priority: 20,
        match: {
            principals: ['proposer'],
            capabilities: [
                'discover_existence',
                'read_owner_truth',
                'read_derivative',
                'trace_provenance',
                'read_receipts',
                'read_command',
                'explain_retrieval',
                'propose_mutation',
                'validate_command',
            ],
        },
        decision: 'allow',
        reason: 'Proposer can read and propose but not approve or commit.',
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
        reason: 'Proposers cannot commit, approve, or compensate. Those require elevated roles.',
    },
];

export const DEFAULT_TRUST_ZONES: TrustZone[] = [
    {
        id: 'internal',
        name: 'Internal (trusted)',
        defaultCapabilities: [
            'discover_existence',
            'read_owner_truth',
            'read_derivative',
            'trace_provenance',
            'read_receipts',
            'read_command',
            'explain_retrieval',
        ],
        defaultScope: { stores: ['*'] },
        approvalMode: 'auto',
        redactionRules: [],
        visibilityRules: [],
    },
    {
        id: 'ai-facing',
        name: 'AI-Facing (MCP/SDK)',
        defaultCapabilities: [
            'discover_existence',
            'read_derivative',
            'explain_retrieval',
        ],
        defaultScope: { stores: ['*'] },
        approvalMode: 'require_approval_for_writes',
        redactionRules: [
            {
                id: 'ai-strip-artifact-content',
                target: 'artifact_content',
                behavior: 'strip',
                reason: 'AI-facing zone does not receive raw artifact content by default.',
            },
        ],
        visibilityRules: [],
    },
    {
        id: 'external',
        name: 'External (untrusted)',
        defaultCapabilities: ['discover_existence', 'read_derivative'],
        defaultScope: { stores: ['index'] },
        approvalMode: 'require_approval',
        redactionRules: [
            {
                id: 'external-strip-content',
                target: 'artifact_content',
                behavior: 'strip',
                reason: 'External zone has no access to artifact content.',
            },
            {
                id: 'external-mask-actors',
                target: 'provenance_actors',
                behavior: 'mask',
                reason: 'External zone cannot see internal actor identities.',
            },
        ],
        visibilityRules: [
            {
                id: 'external-hide-ledger',
                scope: { stores: ['ledger'] },
                existenceVisible: false,
                emitPlaceholder: false,
            },
        ],
    },
];

export const DEFAULT_VISIBILITY_RULES: VisibilityRule[] = [
    {
        id: 'hide-restricted-artifacts',
        scope: { stores: ['artifact'], kinds: ['restricted'] },
        existenceVisible: false,
        emitPlaceholder: true,
    },
];
