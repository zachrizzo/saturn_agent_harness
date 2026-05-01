// Simple read-only history view — minimal for now
export default async function HistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="px-6 py-8">
      <h1 className="text-[15px] font-semibold mb-2">Session History</h1>
      <a
        href={`/api/sessions/${id}/export`}
        className="text-[var(--accent)] text-[13px] hover:underline"
      >
        Export session JSON →
      </a>
    </div>
  );
}
