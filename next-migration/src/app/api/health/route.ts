import { NextResponse } from "next/server";
import { dbReady } from "@/lib/supabase";

export async function GET() {
  return NextResponse.json({ ok: true, db: dbReady() });
}