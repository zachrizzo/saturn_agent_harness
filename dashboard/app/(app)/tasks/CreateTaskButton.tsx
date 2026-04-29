"use client";

import { useEffect, useId, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Portal } from "@/app/components/Portal";
import { Button, Card, Input, Select, Textarea } from "@/app/components/ui";
import { IconX } from "@/app/components/shell/icons";
import type { Task, TaskPriority } from "@/lib/tasks";

type CreateTaskResponse = {
  task?: Task;
  error?: string;
};

function IconPlus({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CreateTaskModal({ onClose, onCreated }: { onClose: () => void; onCreated: (task: Task) => void }) {
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || saving) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: trimmedTitle,
          description: description.trim(),
          priority,
          tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          created_by: "human",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as CreateTaskResponse;
      if (!res.ok || !data.task) {
        throw new Error(data.error ?? "Failed to create task");
      }
      onCreated(data.task);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task");
      setSaving(false);
    }
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button
          type="button"
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          aria-label="Close new task dialog"
          onClick={() => {
            if (!saving) onClose();
          }}
        />
        <Card className="relative w-full max-w-lg p-5 shadow-lg">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-[17px] font-semibold tracking-tight">New task</h2>
              <p className="mt-1 text-[12px] text-muted">Create shared work for humans or agents.</p>
            </div>
            <Button type="button" size="icon" variant="ghost" onClick={onClose} disabled={saving} aria-label="Close">
              <IconX />
            </Button>
          </div>

          <form onSubmit={submit} className="mt-5 space-y-4">
            {error && (
              <div className="rounded-lg border border-[color-mix(in_srgb,var(--fail)_30%,var(--border))] bg-bg-subtle px-3 py-2 text-[12px] text-[var(--fail)]">
                {error}
              </div>
            )}

            <label className="block space-y-1.5">
              <span className="text-[12px] text-muted">Title</span>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What needs doing?"
                autoFocus
                required
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[12px] text-muted">Description</span>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Optional context, constraints, or handoff notes"
                rows={5}
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <label className="block space-y-1.5">
                <span className="text-[12px] text-muted">Priority</span>
                <Select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </Select>
              </label>

              <label className="block space-y-1.5">
                <span className="text-[12px] text-muted">Tags</span>
                <Input
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="ui, follow-up, bug"
                />
              </label>
            </div>

            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={saving || !title.trim()} className="gap-1.5">
                <IconPlus />
                {saving ? "Creating" : "Create task"}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </Portal>
  );
}

export function CreateTaskButton({ className = "" }: { className?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (searchParams.get("new") === "1") setOpen(true);
  }, [searchParams]);

  function close() {
    setOpen(false);
    if (searchParams.get("new") === "1") {
      router.replace("/tasks", { scroll: false });
    }
  }

  function created(task: Task) {
    setOpen(false);
    router.push(`/tasks/${task.id}`);
  }

  return (
    <>
      <Button type="button" variant="primary" onClick={() => setOpen(true)} className={`gap-1.5 ${className}`.trim()}>
        <IconPlus />
        New task
      </Button>
      {open && <CreateTaskModal onClose={close} onCreated={created} />}
    </>
  );
}
