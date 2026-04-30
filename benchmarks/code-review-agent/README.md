# Code Review Agent Benchmark

This benchmark has two small fixtures for Saturn's active code review agent:

- `fixture` is deliberately vulnerable and buggy. It tests whether the agent catches
  security, correctness, performance, and coverage issues.
- `clean-fixture` is intentionally straightforward and covered. It tests whether the
  agent avoids false positives and says there are no actionable findings.

Run it against a local Saturn server:

```bash
AUTOMATIONS_ROOT=/Users/zachrizzo/programming/saturn_agent_harness node bin/benchmark-code-review-agent.mjs
CODE_REVIEW_BENCHMARK_CASE=clean AUTOMATIONS_ROOT=/Users/zachrizzo/programming/saturn_agent_harness node bin/benchmark-code-review-agent.mjs
```

The fixture is not production code. Keep the flaws obvious enough to make regressions
actionable, but varied enough that a shallow review cannot pass by only checking one class
of bug.
