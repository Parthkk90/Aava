import type { ObservatoryEnv, ObservatoryTest, TestResult } from "./types.ts";
import { OBSERVATORY_TESTS } from "./tests.ts";

export * from "./types.ts";
export { OBSERVATORY_TESTS, originOf } from "./tests.ts";
export { isKnownTracker, TRACKER_DOMAINS } from "./trackers.ts";

/** Runs one test. Exceptions become FAIL with the error as evidence — never a silent PASS. */
export async function runTest(test: ObservatoryTest, env: ObservatoryEnv): Promise<TestResult> {
  const started = Date.now();
  let outcome;
  try {
    outcome = await test.run(env);
  } catch (e) {
    outcome = { status: "FAIL" as const, evidence: [`Test threw an error: ${(e as Error).message}`] };
  }
  const finished = Date.now();
  return {
    id: test.id,
    title: test.title,
    category: test.category,
    version: test.version,
    status: outcome.status,
    method: test.method,
    evidence: outcome.evidence,
    limitations: [...test.limitations, ...(outcome.limitations ?? [])],
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
  };
}

export async function runAll(env: ObservatoryEnv, tests = OBSERVATORY_TESTS, onResult?: (r: TestResult) => void): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const t of tests) {
    const r = await runTest(t, env);
    results.push(r);
    onResult?.(r);
  }
  return results;
}
