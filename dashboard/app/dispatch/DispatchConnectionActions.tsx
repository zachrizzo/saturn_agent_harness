"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  chatId: string;
};

export function DispatchConnectionActions({ chatId }: Props): JSX.Element {
  const router = useRouter();
  const [removing, setRemoving] = useState(false);

  const removeConnection = async () => {
    const confirmed = window.confirm(
      `Remove Telegram chat ${chatId} from Dispatch? This clears its session mapping, queue, and per-chat routing settings.`,
    );
    if (!confirmed) return;

    setRemoving(true);
    try {
      const res = await fetch(`/api/dispatch/connections/${encodeURIComponent(chatId)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null) as
        | { error?: string; restartError?: string }
        | null;
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
      if (data?.restartError) {
        window.alert(`Connection removed, but the bridge restart failed: ${data.restartError}`);
      }
      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to remove connection");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <button
      type="button"
      className="btn text-[12px] py-1 px-2.5 text-[var(--fail)]"
      onClick={removeConnection}
      disabled={removing}
      title="Remove this Telegram connection"
    >
      {removing ? "Removing..." : "Remove"}
    </button>
  );
}
