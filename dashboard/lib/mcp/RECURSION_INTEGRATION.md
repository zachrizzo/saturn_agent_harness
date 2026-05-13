# Recursion cap behavior

`tools.ts` already wires `checkAndIncrementRecursion` / `decrementRecursion`
into slice dispatch for slices that can call the orchestrator MCP again.

Recursion caps are optional. The guard only runs when the effective
orchestrator limits include `max_recursion_depth`; blank agent budgets leave it
undefined, so nested orchestrator dispatches are not depth-limited by default.

When a cap is explicitly configured, a dispatch at `currentDepth >= maxDepth`
returns `recursion_limit_exceeded` and the caller can synthesize with the work
already completed.
