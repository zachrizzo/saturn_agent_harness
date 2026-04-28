import { SliceForm } from "../SliceForm";

export const dynamic = "force-dynamic";

export default function NewSlicePage() {
  return (
    <div className="px-6 py-4">
      <h1 className="text-[15px] font-semibold mb-5">New slice</h1>
      <SliceForm />
    </div>
  );
}
