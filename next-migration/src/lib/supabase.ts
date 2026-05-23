import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } })
    : null;

export function dbReady() {
  return Boolean(supabase);
}

export async function getProject(projectKey: string) {
  if (!supabase) {
    throw new Error("Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.");
  }

  const { data, error } = await supabase
    .from("wc_projects")
    .select("id, project_key")
    .eq("project_key", projectKey)
    .single();

  if (error) throw error;
  return data;
}

export function mapGiftRows(items: any[], contributions: any[]) {
  const byGift = new Map<string, any[]>();
  for (const c of contributions || []) {
    const key = c.gift_item_id || "__ungrouped__";
    if (!byGift.has(key)) byGift.set(key, []);
    byGift.get(key)!.push(c);
  }

  return (items || []).map((item) => {
    const rows = byGift.get(item.id) || [];
    const contributorNames = rows
      .map((r) => (r.contributor_name || "").trim())
      .filter(Boolean)
      .slice(0, 5);

    const targetAmount = Number(item.target_amount || 0);
    const dbFundedAmount = Number(item.funded_amount || 0);
    const paidFromContrib = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const fundedAmount = dbFundedAmount > 0 ? dbFundedAmount : paidFromContrib;
    const status = (item.status || "").toLowerCase();
    const isFullyFunded = status === "fully_funded" || (targetAmount > 0 && fundedAmount >= targetAmount);

    return {
      id: item.id,
      title: item.title || "Gift Item",
      description: item.description || "",
      imageUrl: item.image_url || "",
      contributorNames,
      targetAmount,
      fundedAmount,
      status,
      isFullyFunded,
    };
  });
}

export function mapAdminGiftItems(items: any[], contributions: any[]) {
  const byGift = new Map<string, any[]>();
  for (const c of contributions || []) {
    const key = c.gift_item_id || "__ungrouped__";
    if (!byGift.has(key)) byGift.set(key, []);
    byGift.get(key)!.push(c);
  }

  return (items || []).map((item, idx) => {
    const rows = byGift.get(item.id) || [];
    const targetAmount = Number(item.target_amount || 0);
    const dbFundedAmount = Number(item.funded_amount || 0);
    const paidFromContrib = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const fundedAmount = dbFundedAmount > 0 ? dbFundedAmount : paidFromContrib;

    return {
      id: item.id,
      title: item.title || "",
      description: item.description || "",
      imageUrl: item.image_url || "",
      productUrl: item.product_url || "",
      targetAmount,
      fundedAmount,
      status: (item.status || "available").toLowerCase(),
      sortOrder: Number(item.sort_order ?? idx),
      contributorCount: rows.length,
    };
  });
}
