"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { InspectorTool } from "./Inspector";

type Ctx = {
  activeId: string | null;
  select: (tool: InspectorTool) => void;
};

const ActiveToolIdContext = createContext<string | null>(null);
const SelectToolContext = createContext<Ctx["select"]>(() => {});

export function ToolSelectionProvider({
  value,
  children,
}: {
  value: Ctx;
  children: ReactNode;
}) {
  return (
    <SelectToolContext.Provider value={value.select}>
      <ActiveToolIdContext.Provider value={value.activeId}>
        {children}
      </ActiveToolIdContext.Provider>
    </SelectToolContext.Provider>
  );
}

export function useToolSelection(): Ctx {
  const activeId = useContext(ActiveToolIdContext);
  const select = useContext(SelectToolContext);
  return useMemo(() => ({ activeId, select }), [activeId, select]);
}

export function useActiveToolId(): string | null {
  return useContext(ActiveToolIdContext);
}

export function useSelectTool(): Ctx["select"] {
  return useContext(SelectToolContext);
}
