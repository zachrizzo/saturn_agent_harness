import Link from "next/link";
import type { SessionMeta } from "@/lib/runs";
import { Chip } from "@/app/components/ui";
import { toInboxSessions } from "@/lib/chat-inbox";

type Props = {
  sessions: SessionMeta[];
};

export function RecentChatsRail({ sessions }: Props) {
  const list = toInboxSessions(sessions).slice(0, 6);
  if (list.length === 0) {
    return (
      <div className="card p-6 text-center">
        <div className="text-[13px] text-muted">No recent chats.</div>
        <Link
          href="/chats/new"
          className="text-[12px] text-accent hover:underline mt-1 inline-block"
        >
          Start one →
        </Link>
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto md:overflow-visible md:flex-wrap pb-1 -mx-1 px-1">
      {list.map((s) => (
        <Link
          key={s.id}
          href={`/chats/${s.id}`}
          className="shrink-0 md:shrink w-[240px] h-[96px] rounded-lg border border-border bg-bg-elev hover:bg-bg-hover hover:border-border-strong transition-colors p-3 flex flex-col justify-between"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {s.isSwarm && (
              <Chip
                variant="accent"
                className="text-[9.5px]"
                style={{ background: "color-mix(in srgb, var(--purple) 18%, transparent)", color: "var(--purple)", borderColor: "color-mix(in srgb, var(--purple) 30%, transparent)" }}
              >
                swarm
              </Chip>
            )}
            <div
              className="text-[13px] font-medium truncate text-fg flex-1 min-w-0"
              title={s.title}
            >
              {s.title}
            </div>
          </div>
          <div className="text-[11.5px] text-muted line-clamp-2 leading-snug">
            {s.who === "you" ? <span className="text-subtle">you › </span> : null}
            {s.preview}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-subtle truncate">{s.agent}</span>
            <span className="text-[10px] text-subtle tabular-nums">{s.relTime}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
