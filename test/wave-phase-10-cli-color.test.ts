/**
 * Phase 10 §3b — CLI color polish tests (Stage-D folded sub-task).
 *
 * Verifies the kleur-based color helpers honour:
 *   - `NO_COLOR` env variable (https://no-color.org)
 *   - `setCliColorEnabled(false)` override (wired to `--no-color` CLI flag)
 *   - Each semantic helper applies its assigned style when enabled
 *   - `colorizeFormattedError` splits and styles the two-line shape
 *     produced by `formatForUser`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import kleur from 'kleur';

import {
    setCliColorEnabled,
    isCliColorEnabled,
    cliColor,
    colorizeFormattedError,
} from '../src/cli/color-output.js';

// ANSI escape regex — matches the SGR sequences kleur emits.
const ANSI_RE = /\x1b\[[0-9;]*m/;

describe('Phase 10 §3b CLI color polish', () => {
    let savedNoColor: string | undefined;
    let savedKleurEnabled: boolean;

    beforeEach(() => {
        savedNoColor = process.env.NO_COLOR;
        savedKleurEnabled = kleur.enabled;
        delete process.env.NO_COLOR;
        // Force-enable for the per-test setup; individual tests can toggle.
        setCliColorEnabled(true);
    });

    afterEach(() => {
        if (savedNoColor === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = savedNoColor;
        }
        // Restore kleur's state to whatever the test runner had at start.
        kleur.enabled = savedKleurEnabled;
    });

    it('disables color when --no-color flag is set', () => {
        setCliColorEnabled(false);
        expect(isCliColorEnabled()).toBe(false);
        const out = cliColor.error('boom');
        expect(out).toBe('boom');
        expect(ANSI_RE.test(out)).toBe(false);
    });

    it('disables color when NO_COLOR env var is set (no-color.org convention)', () => {
        process.env.NO_COLOR = '1';
        // Re-evaluate via the setter — emulates the preAction hook firing
        // after env was set on a fresh process.
        setCliColorEnabled(true);
        expect(isCliColorEnabled()).toBe(false);
        const out = cliColor.warn('careful');
        expect(out).toBe('careful');
        expect(ANSI_RE.test(out)).toBe(false);
    });

    it('every helper is a pass-through when color is disabled', () => {
        setCliColorEnabled(false);
        expect(cliColor.error('e')).toBe('e');
        expect(cliColor.warn('w')).toBe('w');
        expect(cliColor.success('s')).toBe('s');
        expect(cliColor.header('h')).toBe('h');
        expect(cliColor.hint('hint')).toBe('hint');
    });

    it('emits ANSI codes for every helper when color is enabled', () => {
        setCliColorEnabled(true);
        expect(isCliColorEnabled()).toBe(true);
        expect(ANSI_RE.test(cliColor.error('e'))).toBe(true);
        expect(ANSI_RE.test(cliColor.warn('w'))).toBe(true);
        expect(ANSI_RE.test(cliColor.success('s'))).toBe(true);
        expect(ANSI_RE.test(cliColor.header('h'))).toBe(true);
        expect(ANSI_RE.test(cliColor.hint('hint'))).toBe(true);
        // The original text survives the wrapping.
        expect(cliColor.error('boom').includes('boom')).toBe(true);
    });

    it('colorizeFormattedError pass-through preserves the formatForUser two-line shape when disabled', () => {
        const formatted = 'Command queue corrupt at /path/queue.json\n  → try: run `db-cluster doctor` to inspect';
        setCliColorEnabled(false);
        expect(colorizeFormattedError(formatted)).toBe(formatted);
    });

    it('colorizeFormattedError styles headline + hint independently when enabled', () => {
        const formatted = 'Bad command\n  → try: re-run with --help';
        setCliColorEnabled(true);
        const out = colorizeFormattedError(formatted);
        // Both substrings remain readable.
        expect(out.includes('Bad command')).toBe(true);
        expect(out.includes('→ try: re-run with --help')).toBe(true);
        // ANSI codes appear in the output.
        expect(ANSI_RE.test(out)).toBe(true);
    });

    it('colorizeFormattedError handles plain Error.message strings (no hint separator)', () => {
        const plainMessage = 'An internal error occurred.';
        setCliColorEnabled(false);
        // Disabled: pass-through unchanged.
        expect(colorizeFormattedError(plainMessage)).toBe(plainMessage);
        // Enabled: wraps the whole string as error.
        setCliColorEnabled(true);
        const colored = colorizeFormattedError(plainMessage);
        expect(colored.includes(plainMessage)).toBe(true);
        expect(ANSI_RE.test(colored)).toBe(true);
    });

    it('--no-color overrides positive intent even when NO_COLOR is not set', () => {
        // Common case: user passes --no-color on the CLI but does NOT set
        // the env var. preAction sets enabled=false; we verify it sticks.
        setCliColorEnabled(true);
        expect(isCliColorEnabled()).toBe(true);
        setCliColorEnabled(false);
        expect(isCliColorEnabled()).toBe(false);
        expect(cliColor.error('boom')).toBe('boom');
    });
});
