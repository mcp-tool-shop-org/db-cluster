import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        exclude: [
            'test/cli.test.ts',
            'test/cli-docs.test.ts',
            'test/phase10-proof.test.ts',
            'test/phase15-proof.test.ts',
            'test/install-smoke.test.ts',
            'test/wave6-proof.test.ts',
            'test/policy-surface.test.ts',
            'test/wave-a3-tests-regression.test.ts',
            'test/wave-a3-surface-regression.test.ts',
            'test/wave-a3-stores-regression.test.ts',
        ],
        fileParallelism: false,
    },
});
