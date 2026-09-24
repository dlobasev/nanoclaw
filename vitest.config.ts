import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['src/test-setup.ts'],
    // The scripts/ tooling tests (update-nanoclaw, update-skills, skill scopes)
    // drive real git init/clone/commit against temp fixtures, which does not fit
    // vitest's 5s default on a laptop or a small VM. Everything else runs in
    // milliseconds, so this only widens the window for a genuine hang.
    testTimeout: 30_000,
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts', 'container/*.test.ts'],
  },
});
