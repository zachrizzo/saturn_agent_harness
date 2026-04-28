"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { InspectorTool } from "./Inspector";

type Ctx = {
  activeId: string | null;
  select: (tool: InspectorTool) => void;
};

const ToolSelectionContext = createContext<Ctx>({
  activeId: null,
  select: () => {},
});

export function ToolSelectionProvider({
  value,
  children,
}: {
  value: Ctx;
  children: ReactNode;
}) {
  return <ToolSelectionContext.Provider value={value}>{children}</ToolSelectionContext.Provider>;
}

export function useToolSelection(): Ctx {
  return useContext(ToolSelectionContext);
}
