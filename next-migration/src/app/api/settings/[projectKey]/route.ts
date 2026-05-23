import { NextRequest, NextResponse } from "next/server";
import { getProject, supabase } from "@/lib/supabase";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ projectKey: string }> }) {
  try {
    if (!supabase) {
      return NextResponse.json({ error: "Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env." }, { status: 500 });
    }

    const { projectKey } = await params;
    const project = await getProject(projectKey);
    const { data, error } = await supabase
      .from("wc_site_settings")
      .select("settings, is_published, updated_at")
      .eq("project_id", project.id)
      .single();

    if (error) throw error;
    return NextResponse.json({ projectKey: project.project_key, ...data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to fetch settings." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ projectKey: string }> }) {
  try {
    if (!supabase) {
      return NextResponse.json({ error: "Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env." }, { status: 500 });
    }

    const body = await req.json();
    const { projectKey } = await params;
    const project = await getProject(projectKey);
    const payload = {
      project_id: project.id,
      settings: body?.settings || {},
      is_published: typeof body?.is_published === "boolean" ? body.is_published : true,
    };

    const { error } = await supabase.from("wc_site_settings").upsert(payload, { onConflict: "project_id" });
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save settings." }, { status: 500 });
  }
}