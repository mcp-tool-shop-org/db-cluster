// FIXTURE (R10 — should NOT match): the sanctioned post-REDACT-002 shape.
// No local path-scrub regex literal; the canonical scrubber is imported
// from the redactor. Scanned only by the R10 meta-test.
import { redactErrorMessage, PATH_REGEX } from '../../../src/policy/redactor.js';

export function scrub(s: string): string {
    // Re-uses the single source of truth — no drive-letter regex re-declared.
    return s.replace(PATH_REGEX, '<path>');
}

export function scrubError(err: unknown): string {
    return redactErrorMessage(err);
}
