import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['plugins/*/test/*.test.mjs', 'test/*.test.mjs'],
    // The tests start real shells, PowerShell and git; some take seconds,
    // more on Windows.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // In CI: every test in the log, and failures annotated on the commit.
    ...(process.env.GITHUB_ACTIONS === 'true' && { reporters: ['tree', 'github-actions'] }),
  },
});
