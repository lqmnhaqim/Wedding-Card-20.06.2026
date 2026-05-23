import { NextRequest, NextResponse } from "next/server";
import { getProject, mapGiftRows, supabase } from "@/lib/supabase";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ projectKey: string }> }) {
  try {
    if (!supabase) {
      return NextResponse.json({ error: "Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env." }, { status: 500 });
    }

    const { projectKey } = await params;

    const legacyItems = await supabase
      .from("gift_items")
      .select("id,title,description,image_url,target_amount,status,created_at,product_url")
      .order("created_at", { ascending: true });

    if (!legacyItems.error && Array.isArray(legacyItems.data) && legacyItems.data.length) {
      const legacyContrib = await supabase
        .from("gift_contributions")
        .select("gift_item_id,contributor_name,amount,status,created_at")
        .in("status", ["paid", "success", "completed"])
        .order("created_at", { ascending: true });

      const rows = mapGiftRows(legacyItems.data, legacyContrib.error ? [] : legacyContrib.data || []);
      return NextResponse.json({ source: "gift_items", items: rows });
    }

    const project = await getProject(projectKey);
    const wcItems = await supabase
      .from("wc_gift_items")
      .select("id,title,description,image_url,target_amount,funded_amount,status,sort_order,created_at")
      .eq("project_id", project.id)
      .order("sort_order", { ascending: true });

    if (wcItems.error) throw wcItems.error;

    const wcContrib = await supabase
      .from("wc_contributions")
      .select("contributor_name,status,created_at")
      .eq("project_id", project.id)
      .eq("status", "paid")
      .order("created_at", { ascending: true });

    if (Array.isArray(wcItems.data) && wcItems.data.length) {
      const rows = (wcItems.data || []).map((item) => ({
        targetAmount: Number(item.target_amount || 0),
        fundedAmount: Number(item.funded_amount || 0),
        status: (item.status || "").toLowerCase(),
        isFullyFunded:
          (item.status || "").toLowerCase() === "fully_funded" ||
          (Number(item.target_amount || 0) > 0 && Number(item.funded_amount || 0) >= Number(item.target_amount || 0)),
        id: item.id,
        title: item.title || "Gift Item",
        description: item.description || "",
        imageUrl: item.image_url || "",
        contributorNames: (wcContrib.error ? [] : wcContrib.data || [])
          .map((r) => (r.contributor_name || "").trim())
          .filter(Boolean)
          .slice(0, 5),
      }));

      return NextResponse.json({ source: "wc_gift_items", items: rows });
    }

    return NextResponse.json({ source: "none", items: [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to fetch gift list." }, { status: 500 });
  }
}