import { NextRequest, NextResponse } from "next/server";
import { getProject, supabase } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    if (!supabase) {
      return NextResponse.json(
        { error: "Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env." },
        { status: 500 }
      );
    }

    const body = await req.json();
    const projectKey = String(body?.projectKey || "haqim-myra-2026").trim();
    const fullName = String(body?.full_name || "").trim();
    const attendance = String(body?.attendance || "").trim();

    if (!fullName) return NextResponse.json({ error: "full_name is required" }, { status: 400 });
    if (attendance !== "attending" && attendance !== "not_attending") {
      return NextResponse.json({ error: "attendance must be attending or not_attending" }, { status: 400 });
    }

    const project = await getProject(projectKey);
    const paxValue = body?.pax == null || body?.pax === "" ? null : Number(body.pax);
    const payload = {
      project_id: project.id,
      full_name: fullName,
      attendance,
      pax: attendance === "attending" ? (Number.isFinite(paxValue) ? paxValue : 1) : null,
      wish_message: body?.wish_message ? String(body.wish_message).trim() : null,
    };

    const { error } = await supabase.from("wc_rsvps").insert(payload);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    return NextResponse.json(
      { error: message || "Unable to submit RSVP." },
      { status: 500 }
    );
  }
}
