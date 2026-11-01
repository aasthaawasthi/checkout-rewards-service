/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  // Tests share nothing (each uses its own SQLite file), but the multi-process
  // test spawns servers, so keep the suite serial for predictable timing.
  maxWorkers: 1,
  testTimeout: 30000,
};
