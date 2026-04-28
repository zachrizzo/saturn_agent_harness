"use client";

import { useCallback } from "react";
import { ToolChip, type ToolChipData } from "./ToolChip";
import { useToolSelection } from "./tool-selection";

type Props = {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  isError?: boolean;
  hasResult: boolean;
};

/** Thin wrapper that exposes the tool call as a clickable chip and
 *  forwards selection state to the chat view's Inspector. */
export function ToolInvocation({ id, name, input, result, isError, hasResult }: Props) {
  const { activeId, select } = useToolSelection();
  const status: ToolChipData["status"] = !hasResult ? "run" : isError ? "err" : "ok";
  const handle = useCallback(() => {
    select({ id, name, input, result, status });
  }, [id, name, input, result, status, select]);

  return (
    <ToolChip
      tool={{ id, name, input, result, status }}
      active={activeId === id}
      onClick={handle}
    />
  );
}
