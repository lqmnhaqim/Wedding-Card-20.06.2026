import { NextRequest, NextResponse } from "next/server";
import { getProject, supabase } from "@/lib/supabase";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ projectKey: string }> }) {
  try {
    if (!supabase) {
      return NextResponse.json(
        { error: "Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env." },
        { status: 500 }
      );
    }

    const { projectKey } = await params;
    const project = await getProject(projectKey);
    const { data, error } = await supabase
      .from("wc_rsvps")
      .select("full_name,wish_message,created_at")
      .eq("project_id", project.id)
      .not("wish_message", "is", null)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw error;

    const wishes = (data || [])
      .map((row) => ({
        name: String(row.full_name || "").trim(),
        message: String(row.wish_message || "").trim(),
        created_at: row.created_at || null
      }))
      .filter((row) => row.name && row.message);

    return NextResponse.json({ wishes });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to fetch RSVP wishes." },
      { status: 500 }
    );
  }
}

