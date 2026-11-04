import { withStartupRetry } from '../src/db/database';

/**
 * Two instances starting on a new database can lose a lock race (SQLITE_BUSY)
 * or re-run a migration the other just applied ("already exists"). Startup
 * steps are repeatable, so those errors are retried; anything else is not.
 */
describe('startup retry', () => {
  const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

  it('retries a step that lost a lock race, then succeeds', () => {
    let calls = 0;
    const result = withStartupRetry(() => {
      calls++;
      if (calls < 3) throw busy();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('retries a migration that another instance already applied', () => {
    let calls = 0;
    withStartupRetry(() => {
      if (++calls === 1) throw new Error('table `carts` already exists');
    });
    expect(calls).toBe(2);
  });

  it('does not retry unrelated errors', () => {
    let calls = 0;
    expect(() =>
      withStartupRetry(() => {
        calls++;
        throw new Error('no such column: foo');
      }),
    ).toThrow('no such column');
    expect(calls).toBe(1);
  });

  it('gives up after the attempt limit', () => {
    let calls = 0;
    expect(() =>
      withStartupRetry(() => {
        calls++;
        throw busy();
      }, 3),
    ).toThrow('database is locked');
    expect(calls).toBe(3);
  });
});
