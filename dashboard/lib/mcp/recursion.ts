// Recursion depth tracker for the orchestrator dispatch loop.
//
// `budget.json` stores `recursion_depth` (number). `updateBudget` does
// additive merges for numeric fields, so passing `{ recursion_depth: 1 }`
// increments the counter and `{ recursion_depth: -1 }` decrements it.
//
// Callers (dispatch_slice / dispatch_custom_slice in tools.ts) should:
//   1. Call checkAndIncrementRecursion before spawning a sub-orchestrator.
//   2. Call decrementRecursion in the finally block after the child finishes.

import { readBudget, updateBudget } from "../budget";

/**
 * Checks whether another level of orchestrator recursion is allowed, and if
 * so atomically increments the depth counter.
 *
 * @param sessionId   The session whose budget.json tracks recursion.
 * @param maxDepth    The orchestrator's configured max_recursion_depth (default 3).
 * @returns `{ allowed: true, currentDepth }` when the call may proceed;
 *          `{ allowed: false, currentDepth }` when the cap would be exceeded.
 */
export async function checkAndIncrementRecursion(
  sessionId: string,
  maxDepth: number,
): Promise<{ allowed: boolean; currentDepth: number }> {
  const budget = await readBudget(sessionId);
  if (budget.recursion_depth >= maxDepth) {
    return { allowed: false, currentDepth: budget.recursion_depth };
  }
  // Increment — updateBudget adds the delta to the existing value.
  await updateBudget(sessionId, { recursion_depth: 1 });
  return { allowed: true, currentDepth: budget.recursion_depth + 1 };
}

/**
 * Decrements the recursion depth after a sub-orchestrator finishes.
 * Safe to call even if the depth is already 0 (no underflow).
 */
export async function decrementRecursion(sessionId: string): Promise<void> {
  const budget = await readBudget(sessionId);
  if (budget.recursion_depth > 0) {
    await updateBudget(sessionId, { recursion_depth: -1 });
  }
}
