import { notFound } from "next/navigation";
import { getSlice } from "@/lib/slices";
import { SliceForm } from "../../SliceForm";

export const dynamic = "force-dynamic";

export default async function SliceEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const slice = await getSlice(id);

  if (!slice) {
    notFound();
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Edit slice</h1>
        <p className="text-[13px] text-muted mt-1 mono">{slice.id}</p>
      </header>
      <SliceForm existing={slice} />
    </div>
  );
}
