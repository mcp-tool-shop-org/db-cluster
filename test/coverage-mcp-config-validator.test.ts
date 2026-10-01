/**
 * Coverage — MCP/CLI policy-config validators (src/mcp/config-validator.ts).
 *
 * These validators are the fail-closed gate in front of PolicyEnforcedKernel:
 * a structurally malformed policies.json must be refused with a typed
 * PolicyConfigError carrying a precise `field`, and a well-formed one must pass
 * through unchanged. Each rejection test pins the error's code, field, and
 * message; each acceptance test pins the neighbouring valid shape.
 */

import { describe, it, expect } from 'vitest';
import {
    PolicyConfigError,
    validatePrincipal,
    assertPrincipal,
    validatePolicyConfig,
} from '../src/mcp/config-validator.js';

const goodPrincipal = { id: 'p-1', name: 'Alice Doe', roles: ['observer'], trustZone: 'ai-facing' };

function catchError(fn: () => unknown): PolicyConfigError {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(PolicyConfigError);
        return e as PolicyConfigError;
    }
    throw new Error('expected the call to throw a PolicyConfigError');
}

describe('PolicyConfigError', () => {
    it('carries a stable code, the offending field, and a message that names both', () => {
        const err = new PolicyConfigError('policies[2].id', 'expected a non-empty string');
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('PolicyConfigError');
        expect(err.code).toBe('INVALID_POLICY_CONFIG');
        expect(err.field).toBe('policies[2].id');
        expect(err.message).toBe('Invalid policy config (policies[2].id): expected a non-empty string');
    });
});

describe('validatePrincipal', () => {
    it('accepts a well-formed principal (including empty roles and an empty name)', () => {
        expect(validatePrincipal(goodPrincipal)).toBe(true);
        expect(validatePrincipal({ ...goodPrincipal, roles: [] })).toBe(true);
        expect(validatePrincipal({ ...goodPrincipal, name: '' })).toBe(true);
    });

    it.each([
        ['null', null],
        ['a string', 'p-1'],
        ['a number', 7],
        ['undefined', undefined],
        ['empty id', { ...goodPrincipal, id: '' }],
        ['numeric id', { ...goodPrincipal, id: 1 }],
        ['missing name', { id: 'p-1', roles: [], trustZone: 'z' }],
        ['non-string name', { ...goodPrincipal, name: 5 }],
        ['roles not an array', { ...goodPrincipal, roles: 'observer' }],
        ['roles with a non-string member', { ...goodPrincipal, roles: ['observer', 3] }],
        ['empty trustZone', { ...goodPrincipal, trustZone: '' }],
        ['missing trustZone', { id: 'p-1', name: 'n', roles: [] }],
    ])('rejects %s', (_label, value) => {
        expect(validatePrincipal(value)).toBe(false);
    });
});

describe('assertPrincipal', () => {
    it('returns normally for a valid principal', () => {
        expect(() => assertPrincipal(goodPrincipal, 'principal')).not.toThrow();
    });

    it('throws a PolicyConfigError carrying the field and the required-shape hint', () => {
        const err = catchError(() => assertPrincipal({ id: '' }, 'principal'));
        expect(err.code).toBe('INVALID_POLICY_CONFIG');
        expect(err.field).toBe('principal');
        expect(err.message).toContain('id (non-empty string)');
        expect(err.message).toContain('roles (string[])');
        expect(err.message).toContain('trustZone (non-empty string)');
    });
});

describe('validatePolicyConfig — root', () => {
    it.each([
        ['null', null],
        ['a string', 'policies'],
        ['a number', 3],
        ['an array', []],
    ])('rejects %s at the root', (_label, value) => {
        const err = catchError(() => validatePolicyConfig(value));
        expect(err.field).toBe('root');
        expect(err.message).toContain('expected a JSON object');
    });

    it('accepts an empty object (every section is optional) and returns the same reference', () => {
        const cfg = {};
        expect(validatePolicyConfig(cfg)).toBe(cfg);
    });
});

describe('validatePolicyConfig — policies', () => {
    it('rejects a non-array policies value', () => {
        const err = catchError(() => validatePolicyConfig({ policies: 'not-an-array' }));
        expect(err.field).toBe('policies');
        expect(err.message).toContain('expected an array');
    });

    it.each([
        ['null', null],
        ['a string', 'p'],
        ['an array', []],
    ])('rejects a policy entry that is %s, naming its index', (_label, entry) => {
        const err = catchError(() => validatePolicyConfig({ policies: [{ id: 'ok', decision: 'allow' }, entry] }));
        expect(err.field).toBe('policies[1]');
        expect(err.message).toContain('expected an object');
    });

    it('rejects a policy with a missing or empty id', () => {
        const missing = catchError(() => validatePolicyConfig({ policies: [{ decision: 'allow' }] }));
        expect(missing.field).toBe('policies[0].id');
        expect(missing.message).toContain('non-empty string');
        const empty = catchError(() => validatePolicyConfig({ policies: [{ id: '', decision: 'allow' }] }));
        expect(empty.field).toBe('policies[0].id');
    });

    it('rejects a policy whose decision is not a string', () => {
        const err = catchError(() => validatePolicyConfig({ policies: [{ id: 'p', decision: 1 }] }));
        expect(err.field).toBe('policies[0].decision');
        expect(err.message).toContain('expected a string');
    });

    it('accepts well-formed policies and does not inspect priority/match/reason', () => {
        const cfg = { policies: [{ id: 'p', decision: 'allow', priority: 'whatever', match: 7 }] };
        expect(validatePolicyConfig(cfg)).toBe(cfg);
    });
});

describe('validatePolicyConfig — trustZones', () => {
    it('rejects a non-array trustZones value', () => {
        const err = catchError(() => validatePolicyConfig({ trustZones: { id: 'z' } }));
        expect(err.field).toBe('trustZones');
        expect(err.message).toContain('expected an array');
    });

    it.each([
        ['null', null],
        ['a number', 4],
        ['an array', []],
    ])('rejects a trust zone entry that is %s', (_label, entry) => {
        const err = catchError(() => validatePolicyConfig({ trustZones: [entry] }));
        expect(err.field).toBe('trustZones[0]');
        expect(err.message).toContain('expected an object');
    });

    it('rejects a trust zone with a missing or empty id', () => {
        const err = catchError(() => validatePolicyConfig({ trustZones: [{ id: 'a' }, { name: 'no-id' }] }));
        expect(err.field).toBe('trustZones[1].id');
        const empty = catchError(() => validatePolicyConfig({ trustZones: [{ id: '' }] }));
        expect(empty.field).toBe('trustZones[0].id');
    });

    it('accepts well-formed trust zones', () => {
        const cfg = { trustZones: [{ id: 'ai-facing' }, { id: 'internal', extra: true }] };
        expect(validatePolicyConfig(cfg)).toBe(cfg);
    });
});

describe('validatePolicyConfig — visibilityRules', () => {
    it('rejects a non-array visibilityRules value', () => {
        const err = catchError(() => validatePolicyConfig({ visibilityRules: 'all' }));
        expect(err.field).toBe('visibilityRules');
        expect(err.message).toContain('expected an array');
    });

    it.each([
        ['null', null],
        ['a string', 'rule'],
        ['an array', []],
    ])('rejects a rule entry that is %s', (_label, entry) => {
        const err = catchError(() => validatePolicyConfig({ visibilityRules: [{}, entry] }));
        expect(err.field).toBe('visibilityRules[1]');
        expect(err.message).toContain('expected an object');
    });

    it('accepts an array of objects', () => {
        const cfg = { visibilityRules: [{ anything: 'goes' }, {}] };
        expect(validatePolicyConfig(cfg)).toBe(cfg);
    });
});

describe('validatePolicyConfig — principal', () => {
    it('rejects a malformed principal through assertPrincipal with field "principal"', () => {
        const err = catchError(() => validatePolicyConfig({ principal: { id: 'p', name: 'n', roles: ['r'] } }));
        expect(err.field).toBe('principal');
        expect(err.message).toContain('trustZone');
    });

    it('accepts a complete config with all four sections', () => {
        const cfg = {
            policies: [{ id: 'p', decision: 'allow' }],
            trustZones: [{ id: 'ai-facing' }],
            visibilityRules: [{}],
            principal: goodPrincipal,
        };
        expect(validatePolicyConfig(cfg)).toBe(cfg);
    });
});
