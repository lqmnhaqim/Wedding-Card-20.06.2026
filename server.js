import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 8787);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } })
    : null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function requireDb(res) {
  if (supabase) return true;
  res.status(500).json({
    error: "Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env."
  });
  return false;
}

async function getProject(projectKey) {
  const { data, error } = await supabase
    .from("wc_projects")
    .select("id, project_key")
    .eq("project_key", projectKey)
    .single();
  if (error) throw error;
  return data;
}

function mapGiftRows(items, contributions) {
  const byGift = new Map();
  for (const c of contributions || []) {
    const key = c.gift_item_id || "__ungrouped__";
    if (!byGift.has(key)) byGift.set(key, []);
    byGift.get(key).push(c);
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
      isFullyFunded
    };
  });
}

function mapAdminGiftItems(items, contributions) {
  const byGift = new Map();
  for (const c of contributions || []) {
    const key = c.gift_item_id || "__ungrouped__";
    if (!byGift.has(key)) byGift.set(key, []);
    byGift.get(key).push(c);
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
      contributorCount: rows.length
    };
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, db: Boolean(supabase) });
});

app.get("/api/settings/:projectKey", async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const project = await getProject(req.params.projectKey);
    const { data, error } = await supabase
      .from("wc_site_settings")
      .select("settings, is_published, updated_at")
      .eq("project_id", project.id)
      .single();
    if (error) throw error;
    res.json({ projectKey: project.project_key, ...data });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to fetch settings." });
  }
});

app.put("/api/settings/:projectKey", async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const project = await getProject(req.params.projectKey);
    const payload = {
      project_id: project.id,
      settings: req.body?.settings || {},
      is_published: typeof req.body?.is_published === "boolean" ? req.body.is_published : true
    };
    const { error } = await supabase
      .from("wc_site_settings")
      .upsert(payload, { onConflict: "project_id" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to save settings." });
  }
});

app.get("/api/gift-list/:projectKey", async (req, res) => {
  try {
    if (!requireDb(res)) return;
    // First try legacy/shared tables used by the other project (E-Card 2nd Batch).
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

      const rows = mapGiftRows(legacyItems.data, legacyContrib.error ? [] : legacyContrib.data);
      res.json({ source: "gift_items", items: rows });
      return;
    }

    // Fallback to current project wc_* tables only if legacy is empty.
    const project = await getProject(req.params.projectKey);
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
        contributorNames: (wcContrib.error ? [] : (wcContrib.data || []))
          .map((r) => (r.contributor_name || "").trim())
          .filter(Boolean)
          .slice(0, 5)
      }));
      res.json({ source: "wc_gift_items", items: rows });
      return;
    }

    res.json({ source: "none", items: [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to fetch gift list." });
  }
});

app.get("/api/rsvp-wishes/:projectKey", async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const project = await getProject(req.params.projectKey);
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

    res.json({ wishes });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to fetch RSVP wishes." });
  }
});

app.get("/api/admin/gift-items/:projectKey", async (req, res) => {
  try {
    if (!requireDb(res)) return;

    const legacyItems = await supabase
      .from("gift_items")
      .select("id,title,description,image_url,product_url,target_amount,status,created_at")
      .order("created_at", { ascending: true });

    if (!legacyItems.error && Array.isArray(legacyItems.data) && legacyItems.data.length) {
      const legacyContrib = await supabase
        .from("gift_contributions")
        .select("gift_item_id,amount,status,created_at");
      const rows = mapAdminGiftItems(legacyItems.data, legacyContrib.error ? [] : legacyContrib.data);
      res.json({ source: "gift_items", items: rows });
      return;
    }

    const project = await getProject(req.params.projectKey);
    const wcItems = await supabase
      .from("wc_gift_items")
      .select("id,title,description,image_url,product_url,target_amount,funded_amount,status,sort_order")
      .eq("project_id", project.id)
      .order("sort_order", { ascending: true });
    if (wcItems.error) throw wcItems.error;

    res.json({
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
        contributorCount: 0
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to fetch admin gift items." });
  }
});

app.put("/api/admin/gift-items/:projectKey", async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const source = req.body?.source === "wc_gift_items" ? "wc_gift_items" : "gift_items";

    if (source === "gift_items") {
      // Shared table from existing project. We only upsert submitted rows; no delete.
      const payload = items
        .map((item) => ({
          id: item.id || undefined,
          title: String(item.title || "").trim(),
          description: String(item.description || "").trim(),
          image_url: String(item.imageUrl || "").trim(),
          product_url: String(item.productUrl || "").trim(),
          target_amount: Number(item.targetAmount || 0),
          funded_amount: Number(item.fundedAmount || 0),
          status: String(item.status || "available").trim() || "available"
        }))
        .filter((item) => item.title);

      if (payload.length) {
        const { error } = await supabase.from("gift_items").upsert(payload, { onConflict: "id" });
        if (error) throw error;
      }

      res.json({ ok: true, source: "gift_items" });
      return;
    }

    const project = await getProject(req.params.projectKey);
    const payload = items
      .map((item, idx) => ({
        id: item.id || undefined,
        project_id: project.id,
        title: String(item.title || "").trim(),
        description: String(item.description || "").trim(),
        image_url: String(item.imageUrl || "").trim(),
        product_url: String(item.productUrl || "").trim(),
        target_amount: Number(item.targetAmount || 0),
        funded_amount: Number(item.fundedAmount || 0),
        status: String(item.status || "available").trim() || "available",
        sort_order: idx
      }))
      .filter((item) => item.title);

    if (payload.length) {
      const { error } = await supabase.from("wc_gift_items").upsert(payload, { onConflict: "id" });
      if (error) throw error;
    }
    res.json({ ok: true, source: "wc_gift_items" });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to save admin gift items." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
