"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/app/components/ui";
import { IconTrash } from "@/app/components/shell/icons";

type DeleteJobButtonProps = {
  jobName: string;
  redirectTo?: string;
  label?: string;
};

export function DeleteJobButton({ jobName, redirectTo, label }: DeleteJobButtonProps) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!window.confirm(`Delete job "${jobName}"? This removes it from the schedule but keeps old run logs on disk.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobName)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Delete failed (${res.status})`);
      }
      if (redirectTo) {
        router.push(redirectTo);
      } else {
        router.refresh();
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  };

  return (
    <Button
      type="button"
      variant="danger"
      size={label ? "sm" : "icon"}
      title="Delete job"
      aria-label={`Delete ${jobName}`}
      onClick={handleDelete}
      disabled={deleting}
    >
      <IconTrash className="w-3.5 h-3.5" />
      {label ? <span>{deleting ? "Deleting..." : label}</span> : null}
    </Button>
  );
}
