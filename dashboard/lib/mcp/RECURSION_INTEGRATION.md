# Recursion cap integration

Wire `checkAndIncrementRecursion` / `decrementRecursion` into `tools.ts` at the two dispatch handlers.

## In handleDispatchSlice

After `checkBudget`, before calling `executeSlice`, add:

```ts
// Only enforce recursion cap when dispatching another orchestrator slice.
// Regular (non-orchestrator) slices don't consume a recursion level.
const targetSlice = await getSlice(sliceId);
if (targetSlice?.kind === "orchestrator" || (targetSlice?.cli === "claude-bedrock" && targetSlice?.prompt_template?.system?.includes("orchestrator"))) {
  const maxDepth = agentSnapshot?.budget?.max_recursion_depth ?? 3;
  const { allowed } = await checkAndIncrementRecursion(sessionId, maxDepth);
  if (!allowed) {
    return { status: "budget_exceeded", error: "max recursion depth exceeded", ... };
  }
  // Decrement after executeSlice returns (use try/finally).
}
```

Practical pattern:

```ts
import { checkAndIncrementRecursion, decrementRecursion } from "./recursion";

async function handleDispatchSlice(sessionId, sliceId, inputs, agentSnapshot) {
  // ... checkBudget ...

  // Recursion guard (only for orchestrator-kind slices)
  let trackingRecursion = false;
  const slice = await getSlice(sliceId);
  if (slice && isOrchestratorSlice(slice)) {
    const maxDepth = agentSnapshot?.budget?.max_recursion_depth ?? 3;
    const { allowed } = await checkAndIncrementRecursion(sessionId, maxDepth);
    if (!allowed) {
      return {
        status: "budget_exceeded" as const,
        error: "max recursion depth exceeded",
        slice_run_id: randomUUID(),
        output: null,
        raw_output: "",
        tokens: { input: 0, output: 0, total: 0 },
        duration_ms: 0,
        remaining_budget: await getRemainingBudget(sessionId, agentSnapshot),
      };
    }
    trackingRecursion = true;
  }

  try {
    const result = await executeSlice({ sessionId, sliceId, inputs });
    return { ...result, remaining_budget: await getRemainingBudget(sessionId, agentSnapshot) };
  } finally {
    if (trackingRecursion) {
      await decrementRecursion(sessionId);
    }
  }
}
```

## In handleDispatchCustomSlice

Same pattern — custom slices that include orchestrator-like specs (e.g., include MCP tools or reference orchestrator CLI args) should also be gated. For v1, apply the recursion check only when `spec.allowedTools` contains `mcp__orchestrator__*` entries, indicating the custom slice is itself an orchestrator.

## Acceptance test

Orchestrator A (depth 0) dispatches orchestrator B (depth 1) which dispatches orchestrator C.
With `max_recursion_depth: 2`, the C dispatch is allowed (depth becomes 2).
A subsequent dispatch from C would be rejected (depth 2 >= maxDepth 2).

With `max_recursion_depth: 1`, C's dispatch is immediately rejected.
