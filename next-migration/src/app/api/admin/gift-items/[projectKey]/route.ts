import { NextRequest, NextResponse } from "next/server";
import { getProject, mapAdminGiftItems, supabase } from "@/lib/supabase";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ projectKey: string }> }) {
  try {
    if (!supabase) {
      return NextResponse.json({ error: "Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env." }, { status: 500 });
    }

    const { projectKey } = await params;

    const legacyItems = await supabase
      .from("gift_items")
      .select("id,title,description,image_url,product_url,target_amount,status,created_at")
      .order("created_at", { ascending: true });

    if (!legacyItems.error && Array.isArray(legacyItems.data) && legacyItems.data.length) {
      const legacyContrib = await supabase.from("gift_contributions").select("gift_item_id,amount,status,created_at");
      const rows = mapAdminGiftItems(legacyItems.data, legacyContrib.error ? [] : legacyContrib.data || []);
      return NextResponse.json({ source: "gift_items", items: rows });
    }

    const project = await getProject(projectKey);
    const wcItems = await supabase
      .from("wc_gift_items")
      .select("id,title,description,image_url,product_url,target_amount,funded_amount,status,sort_order")
      .eq("project_id", project.id)
      .order("sort_order", { ascending: true });

    if (wcItems.error) throw wcItems.error;

    return NextResponse.json({
      source: "wc_gift_items",
      items: (wcItems.data || []).map((item, idx) => ({
        id: item.id,
        title: item.title || "",
        description: item.description || "",
        imageUrl: item.image_url || "",
        productUrl: item.product_url || "",
        targetAmount: Number(item.target_amount || 0),
        fundedAmount: Number(item.funded_amount || 0),
        status: (item.status || "available").toLowerCase(),
        sortOrder: Number(item.sort_order ?? idx),
        contributorCount: 0,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to fetch admin gift items." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ projectKey: string }> }) {
  try {
    if (!supabase) {
      return NextResponse.json({ error: "Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env." }, { status: 500 });
    }

    const body = await req.json();
    const { projectKey } = await params;

    const items = Array.isArray(body?.items) ? body.items : [];
    const source = body?.source === "wc_gift_items" ? "wc_gift_items" : "gift_items";

    if (source === "gift_items") {
      const payload = items
        .map((item: any) => ({
          id: item.id || undefined,
          title: String(item.title || "").trim(),
          description: String(item.description || "").trim(),
          image_url: String(item.imageUrl || "").trim(),
          product_url: String(item.productUrl || "").trim(),
          target_amount: Number(item.targetAmount || 0),
          funded_amount: Number(item.fundedAmount || 0),
          status: String(item.status || "available").trim() || "available",
        }))
        .filter((item: any) => item.title);

      if (payload.length) {
        const { error } = await supabase.from("gift_items").upsert(payload, { onConflict: "id" });
        if (error) throw error;
      }

      return NextResponse.json({ ok: true, source: "gift_items" });
    }

    const project = await getProject(projectKey);
    const payload = items
      .map((item: any, idx: number) => ({
        id: item.id || undefined,
        project_id: project.id,
        title: String(item.title || "").trim(),
        description: String(item.description || "").trim(),
        image_url: String(item.imageUrl || "").trim(),
        product_url: String(item.productUrl || "").trim(),
        target_amount: Number(item.targetAmount || 0),
        funded_amount: Number(item.fundedAmount || 0),
        status: String(item.status || "available").trim() || "available",
        sort_order: idx,
      }))
      .filter((item: any) => item.title);

    if (payload.length) {
      const { error } = await supabase.from("wc_gift_items").upsert(payload, { onConflict: "id" });
      if (error) throw error;
    }

    return NextResponse.json({ ok: true, source: "wc_gift_items" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save admin gift items." }, { status: 500 });
  }
}