/**
 * CLI ANSI color helpers (Phase 10 §3b, Stage-D fold).
 *
 * Apply consistent semantic coloring across the db-cluster CLI:
 *
 * | Helper            | Style       | Use site                                          |
 * |-------------------|-------------|---------------------------------------------------|
 * | `cliColor.error`  | red         | Error: prefix in cliCommand's catch arm           |
 * | `cliColor.warn`   | yellow      | warn-level messages from cliWarn                  |
 * | `cliColor.success`| green       | success summaries (init done, ingest complete)    |
 * | `cliColor.header` | bold cyan   | doctor/verify section headers                     |
 * | `cliColor.hint`   | dim italic  | `→ try: <remediation>` lines from formatForUser   |
 *
 * Detection precedence (highest first):
 *   1. `--no-color` CLI flag → forces colors OFF (via `setCliColorEnabled(false)`)
 *   2. `NO_COLOR` env var (https://no-color.org) → kleur honours natively at module load
 *   3. stdout TTY auto-detection → kleur honours natively at module load
 *
 * Each helper is a pass-through string transform — when `kleur.enabled`
 * is false, the input is returned unchanged (kleur returns the raw
 * string with no ANSI bytes). Callers can wrap any string they're
 * about to emit; downstream consumers of piped output see no ANSI bytes.
 */

import kleur from 'kleur';

/**
 * Toggle CLI colors. Called from the preAction hook with the resolved
 * `--no-color` flag value.
 *
 *  - `setCliColorEnabled(false)` always disables, regardless of NO_COLOR /
 *    TTY state — this is the `--no-color` override behaviour.
 *  - `setCliColorEnabled(true)` enables ONLY when `NO_COLOR` is not set.
 *    The NO_COLOR convention is explicit: when set to any non-empty
 *    value, no program shall emit color, period (https://no-color.org).
 */
export function setCliColorEnabled(enabled: boolean): void {
    if (!enabled) {
        kleur.enabled = false;
        return;
    }
    if (process.env.NO_COLOR) {
        kleur.enabled = false;
        return;
    }
    kleur.enabled = true;
}

/** Whether ANSI colors are currently emitted by `cliColor.*` helpers. */
export function isCliColorEnabled(): boolean {
    return kleur.enabled;
}

/**
 * Semantic color wrappers. Each is a pass-through (returns `s` unchanged)
 * when {@link isCliColorEnabled} is false — kleur's own emit logic gates
 * on `kleur.enabled`, so no extra branching is needed here.
 */
export const cliColor = {
    error: (s: string): string => kleur.red(s),
    warn: (s: string): string => kleur.yellow(s),
    success: (s: string): string => kleur.green(s),
    header: (s: string): string => kleur.bold().cyan(s),
    hint: (s: string): string => kleur.dim().italic(s),
};

/**
 * Colorize a `formatForUser` two-line output: the headline gets `error`
 * treatment, the `  → try: <hint>` line gets `hint` treatment.
 *
 * Falls through unchanged when the input doesn't match the expected shape
 * (no `\n  → try: ` separator), so plain `Error.message` strings pass
 * through as a single error-styled line.
 */
export function colorizeFormattedError(formatted: string): string {
    const sep = '\n  → try: ';
    const idx = formatted.indexOf(sep);
    if (idx === -1) return cliColor.error(formatted);
    const head = formatted.slice(0, idx);
    const hint = formatted.slice(idx + sep.length);
    return `${cliColor.error(head)}\n  ${cliColor.hint(`→ try: ${hint}`)}`;
}
