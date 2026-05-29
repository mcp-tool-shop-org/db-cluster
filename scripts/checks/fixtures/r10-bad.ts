// FIXTURE (R10 — should MATCH): a hand-rolled drive-letter path-scrub regex
// declared outside src/policy/redactor.ts. Scanned only by the R10 meta-test.
const PATH_REGEX = /(?:[A-Za-z]:[\\/]|\\\\[^\s"'`)]+[\\/]|\/)[^\s"'`)]+/g;
export function scrub(s: string): string {
    return s.replace(PATH_REGEX, '<path>');
}
