# Evaluations

OpenBot evaluations are ordinary versioned files in `evals/`. They run locally and in CI, do not send data to a hosted grader, and produce a machine-readable report with case outcomes, pass rate, duration, and p50/p95 latency.

Run the deterministic safety suite:

```sh
bun run eval
```

The initial suite exercises action-policy precedence, approval behavior, dry-run behavior, malformed rules, and MCP read/write classification. It needs no model key and should pass at 100%.

Useful environment variables:

- `OPENBOT_EVAL_THRESHOLD=0.95` sets the minimum passing fraction. The default is `1`.
- `OPENBOT_EVAL_REPORT=artifacts/policy-eval.json` writes the same JSON printed to stdout.

`runEvalSuite` is generic: a suite supplies cases, an executor, and a deterministic grader. Use it for agent responses, browser journeys, connector fixtures, or regression corpora. Keep customer prompts and transcripts outside the repository; load private cases from a path provided by the deployment.

For full live-stack browser and policy coverage, also run `bun run test:smoke` against an isolated deployment database.
