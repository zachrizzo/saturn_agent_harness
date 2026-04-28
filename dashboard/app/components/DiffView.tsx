"use client";

// Minimal unified-diff renderer. No external deps. Expects standard git-diff
// output. Pure UI component, no shell invocation.

type Line = {
  kind: "add" | "del" | "ctx" | "hunk" | "file" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
};

function parseDiff(diff: string): Line[] {
  const out: Line[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ") || raw.startsWith("index ")) {
      out.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      out.push({ kind: "file", text: raw });
    } else if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
      }
      out.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), newLine });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldLine });
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      out.push({ kind: "ctx", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else if (raw.length > 0) {
      out.push({ kind: "meta", text: raw });
    }
  }
  return out;
}

export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <p className="text-[12px] text-muted italic">No changes.</p>;
  }
  const lines = parseDiff(diff);
  return (
    <div
      className="font-mono text-[11px] rounded-md border border-border overflow-x-auto"
      style={{ background: "var(--bg)" }}
    >
      {lines.map((ln, i) => {
        if (ln.kind === "hunk") {
          return (
            <div key={i} className="px-2 py-0.5 bg-white/5 text-white/50">
              {ln.text}
            </div>
          );
        }
        if (ln.kind === "file" || ln.kind === "meta") {
          return (
            <div key={i} className="px-2 py-0.5 text-white/40">
              {ln.text}
            </div>
          );
        }

        let bg = "transparent";
        let prefix = " ";
        let gutterNum = ln.newLine;
        if (ln.kind === "add") {
          bg = "rgba(34,197,94,0.12)";
          prefix = "+";
        } else if (ln.kind === "del") {
          bg = "rgba(239,68,68,0.12)";
          prefix = "-";
          gutterNum = ln.oldLine;
        }
        const gutter = String(gutterNum ?? "").padStart(4, " ");

        return (
          <div
            key={i}
            className="flex px-2 whitespace-pre"
            style={{ background: bg }}
          >
            <span className="text-white/30 select-none mr-2">{gutter}</span>
            <span className="w-3 text-white/50 select-none">{prefix}</span>
            <span>{ln.text}</span>
          </div>
        );
      })}
    </div>
  );
}
