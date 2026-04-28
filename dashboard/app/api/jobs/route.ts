import { NextResponse } from "next/server";
import { listJobs } from "@/lib/runs";

export const dynamic = "force-dynamic";

export async function GET() {
  const jobs = await listJobs();
  return NextResponse.json({ jobs });
}
