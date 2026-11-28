// Run in a child process by run-lease.test.ts: a lease held on REAL time and never released (a
// worker whose run is still going when the rest of its work is done). Its renew timer must not be
// what keeps the process alive: the process must exit on its own once nothing else is pending.
import { holdRunLease } from '../../src/run-lease.ts'

await holdRunLease(
  {
    lease: { acquire: () => true, renew: () => true, release: () => {} },
    ttlMs: 3_000,
    owner: 'me',
  },
  'run-1',
)
process.stdout.write('held\n')
