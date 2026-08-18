import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Runs before every test file: redirects the shared data tree away from
    // the developer's real ~/.memorylake. See test/setup.ts.
    setupFiles: ['test/setup.ts'],
  },
})
