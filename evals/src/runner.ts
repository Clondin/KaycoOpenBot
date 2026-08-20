export type EvalCase<Input, Expected> = {
  id: string;
  input: Input;
  expected: Expected;
};

export type EvalResult<Output> = {
  id: string;
  passed: boolean;
  durationMs: number;
  output?: Output;
  reason?: string;
};

export type EvalReport<Output> = {
  suite: string;
  passed: number;
  failed: number;
  passRate: number;
  durationMs: number;
  p50Ms: number;
  p95Ms: number;
  results: EvalResult<Output>[];
};

export async function runEvalSuite<Input, Expected, Output>(input: {
  name: string;
  cases: EvalCase<Input, Expected>[];
  execute: (input: Input) => Output | Promise<Output>;
  grade: (output: Output, expected: Expected) => true | string;
}): Promise<EvalReport<Output>> {
  const suiteStarted = performance.now();
  const results: EvalResult<Output>[] = [];
  for (const evalCase of input.cases) {
    const started = performance.now();
    try {
      const output = await input.execute(evalCase.input);
      const verdict = input.grade(output, evalCase.expected);
      results.push({
        id: evalCase.id,
        passed: verdict === true,
        durationMs: performance.now() - started,
        output,
        ...(verdict === true ? {} : { reason: verdict }),
      });
    } catch (error) {
      results.push({
        id: evalCase.id,
        passed: false,
        durationMs: performance.now() - started,
        reason: error instanceof Error ? error.message : "Evaluation failed.",
      });
    }
  }
  const durations = results
    .map((result) => result.durationMs)
    .sort((a, b) => a - b);
  const passed = results.filter((result) => result.passed).length;
  return {
    suite: input.name,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    durationMs: performance.now() - suiteStarted,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    results,
  };
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? 0;
}
