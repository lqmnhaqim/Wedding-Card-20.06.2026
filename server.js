import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { consumeRateLimit } from "./rate-limit.js";
import crypto from "node:crypto";

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

const rawSandbox = String(process.env.BILLPLZ_SANDBOX || "true").trim();
const isSandbox = rawSandbox === "true" || rawSandbox == "'true'" || rawSandbox == '"true"';
const billplzBaseUrl = isSandbox
  ? "https://www.billplz-sandbox.com/api"
  : "https://www.billplz.com/api";
const telegramEnabled = process.env.TELEGRAM_ENABLED !== "false";

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

function getRequestOrigin(req) {
  const configuredBaseUrl = String(process.env.APP_BASE_URL || "").trim().replace(/^["']|["']$/g, "");
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, "");
  }
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

function getBillplzAuthHeader(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function createBillplzBill(payload) {
  const apiKey = process.env.BILLPLZ_API_KEY?.trim();
  const collectionId = process.env.BILLPLZ_COLLECTION_ID?.trim();

  if (!apiKey || !collectionId) {
    return {
      isMock: true,
      billId: `mock-bill-${Date.now()}`,
      paymentUrl: payload.redirectUrl,
    };
  }

  const formData = new URLSearchParams({
    collection_id: collectionId,
    description: payload.description,
    name: payload.name,
    amount: String(Math.round(payload.amount * 100)),
    callback_url: payload.callbackUrl,
    redirect_url: payload.redirectUrl,
    deliver: "false",
  });

  if (payload.phone) formData.append("mobile", payload.phone);

  const response = await fetch(`${billplzBaseUrl}/v3/bills`, {
    method: "POST",
    headers: {
      Authorization: getBillplzAuthHeader(apiKey),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formData.toString(),
  });

  const rawBody = await response.text();
  if (!response.ok) throw new Error(`Billplz error: ${rawBody.slice(0, 200)}`);

  const data = JSON.parse(rawBody);
  if (!data?.id || !data?.url) {
    throw new Error(`Billplz did not return a bill URL. Response: ${rawBody.slice(0, 200)}`);
  }

  return {
    isMock: false,
    billId: data.id,
    paymentUrl: data.url,
  };
}

async function getBillplzBillStatus(billId) {
  const apiKey = process.env.BILLPLZ_API_KEY?.trim();
  if (!apiKey || !billId) return null;
  const response = await fetch(`${billplzBaseUrl}/v3/bills/${billId}`, {
    method: "GET",
    headers: {
      Authorization: getBillplzAuthHeader(apiKey),
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const rawBody = await response.text();
    throw new Error(`Billplz status error: ${rawBody.slice(0, 200)}`);
  }
  return await response.json();
}

async function getBillplzBillTransactions(billId) {
  const apiKey = process.env.BILLPLZ_API_KEY?.trim();
  if (!apiKey || !billId) return [];
  const response = await fetch(`${billplzBaseUrl}/v3/bills/${billId}/transactions`, {
    method: "GET",
    headers: {
      Authorization: getBillplzAuthHeader(apiKey),
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const rawBody = await response.text();
    throw new Error(`Billplz transactions error: ${rawBody.slice(0, 200)}`);
  }
  const data = await response.json();
  return Array.isArray(data?.transactions) ? data.transactions : [];
}

function verifyBillplzSignature(fields) {
  const rawKey = String(process.env.BILLPLZ_X_SIGNATURE_KEY || "").trim();
  const xSignatureKey = rawKey.replace(/^["']|["']$/g, "");
  if (!xSignatureKey) return true;
  const providedSignature = String(fields.x_signature || "").trim().toLowerCase();
  if (!providedSignature || !/^[a-f0-9]{64}$/.test(providedSignature)) return false;

  const source = Object.entries(fields)
    .filter(([key]) => key !== "x_signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value ?? "")
    .join("|");

  const computed = crypto.createHmac("sha256", xSignatureKey).update(source).digest("hex").toLowerCase();
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(providedSignature, "hex")
    );
  } catch {
    return false;
  }
}

function normalizeBillplzMobile(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  let normalized = raw.replace(/[^\d+]/g, "");
  if (normalized.startsWith("+")) normalized = normalized.slice(1);
  normalized = normalized.replace(/\D/g, "");
  if (normalized.startsWith("0")) normalized = `60${normalized.slice(1)}`;
  if (!normalized.startsWith("60")) normalized = `60${normalized}`;
  return normalized;
}

function normalizeGatewayStatus(status) {
  const value = String(status ?? "").toLowerCase();
  if (value === "completed" || value === "succeeded" || value === "paid" || value === "true") return "paid";
  if (value === "failed" || value === "due" || value === "canceled" || value === "cancelled" || value === "expired" || value === "voided" || value === "deleted") return "failed";
  return "pending";
}

function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegramNotification(message) {
  if (!telegramEnabled) return;
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!botToken || !chatId) return;

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Telegram API error: ${raw.slice(0, 200)}`);
  }
}

function formatRsvpTelegramMessage(rsvp, totalAttendancePax) {
  const name = escapeTelegramHtml(rsvp?.full_name || "-");
  const attendanceRaw = String(rsvp?.attendance || "").toLowerCase();
  const isAttending = attendanceRaw === "attending";
  const attendanceLabel = attendanceRaw === "attending" ? "Attending" : attendanceRaw === "not_attending" ? "Not Attending" : attendanceRaw || "-";
  const pax = isAttending ? escapeTelegramHtml(String(rsvp?.pax ?? 0)) : "-";
  const wish = escapeTelegramHtml(String(rsvp?.wish_message || "-"));
  const total = escapeTelegramHtml(String(totalAttendancePax ?? 0));
  return [
    "<b>RSVP Submitted</b>",
    "",
    `• <b>Name:</b> ${name}`,
    `• <b>Status:</b> ${escapeTelegramHtml(attendanceLabel)}`,
    `• <b>Pax:</b> ${pax}`,
    `• <b>Current Total Attendance:</b> ${total}`,
    `• <b>Wish:</b> ${wish}`,
  ].join("\n");
}

function formatContributionTelegramMessage(contribution, status, paymentReference) {
  const isPaid = status === "paid";
  const title = isPaid ? "Contribution Paid" : "Contribution Failed";
  const name = escapeTelegramHtml(contribution?.contributor_name ?? "Guest");
  const amount = escapeTelegramHtml(String(contribution?.amount ?? "-"));
  const reference = escapeTelegramHtml(contribution?.id ?? "-");
  const orderNo = escapeTelegramHtml(paymentReference || "-");
  return [
    `<b>${title}</b>`,
    "",
    `• <b>Name:</b> ${name}`,
    isPaid ? `• <b>Amount:</b> MYR ${amount}` : null,
    `• <b>Reference:</b> ${reference}`,
    `• <b>Billplz Order:</b> ${orderNo}`,
    `• <b>Status:</b> ${isPaid ? "Paid" : "Failed"}`,
  ].filter(Boolean).join("\n");
}

async function getContributionById(contributionId) {
  if (!contributionId) return null;
  const { data, error } = await supabase
    .from("gift_contributions")
    .select("id,contributor_name,message,amount,status,billplz_bill_id,toyyibpay_bill_code,payment_reference,created_at")
    .eq("id", contributionId)
    .single();
  if (error) {
    console.error("getContributionById - Supabase error for", contributionId, JSON.stringify(error));
    return null;
  }
  return data;
}

async function updateContributionStatus(contributionId, status, billId, paymentReference) {
  const payload = {
    status,
    payment_reference: paymentReference || null,
  };
  if (billId) {
    payload.billplz_bill_id = billId;
    payload.toyyibpay_bill_code = billId;
  }
  const { error } = await supabase.from("gift_contributions").update(payload).eq("id", contributionId);
  if (error) throw error;
}

async function resolveBillplzTransactionReference(billId, fallbackReference, normalizedStatus) {
  if (fallbackReference) return fallbackReference;
  const transactions = await getBillplzBillTransactions(billId);
  if (!transactions.length) return "";
  const preferredStatus = normalizedStatus === "paid" ? "completed" : normalizedStatus === "failed" ? "failed" : "";
  const matchingStatus = preferredStatus
    ? transactions.find((item) => String(item?.status || "").toLowerCase() === preferredStatus)
    : undefined;
  const latestTransaction = [...transactions]
    .sort((left, right) => {
      const leftTime = left?.completed_at ? new Date(left.completed_at).getTime() : 0;
      const rightTime = right?.completed_at ? new Date(right.completed_at).getTime() : 0;
      return rightTime - leftTime;
    })
    .find((item) => item?.id);
  return String(matchingStatus?.id ?? latestTransaction?.id ?? "");
}

async function syncContributionWithBillplz(contributionId) {
  const contribution = await getContributionById(contributionId);
  if (!contribution) return null;
  const billId = contribution.billplz_bill_id || contribution.toyyibpay_bill_code;
  if (!billId) {
    console.log("syncContributionWithBillplz - No billId for contribution:", contributionId);
    return contribution;
  }
  console.log("syncContributionWithBillplz - Checking bill:", billId);
  try {
    const remote = await getBillplzBillStatus(billId);
    console.log("syncContributionWithBillplz - Remote response:", remote ? JSON.stringify(remote) : "null");
    if (!remote) return contribution;
    const remotePaid = remote.paid === true || remote.paid === "true";
    const remoteState = remote.state ? String(remote.state).toLowerCase() : "unknown";
    console.log("syncContributionWithBillplz - paid:", remotePaid, "- state:", remoteState);
    const normalizedStatus = remotePaid ? "paid" : normalizeGatewayStatus(remoteState);
    console.log("syncContributionWithBillplz - Final normalized status:", normalizedStatus);
    const paymentReference = await resolveBillplzTransactionReference(
      billId,
      String(remote.transaction_id ?? contribution.payment_reference ?? ""),
      normalizedStatus
    );
    if (
      normalizedStatus === contribution.status &&
      paymentReference === String(contribution.payment_reference ?? "")
    ) {
      return contribution;
    }
    await updateContributionStatus(contribution.id, normalizedStatus, billId, paymentReference);
    if (normalizedStatus !== contribution.status && (normalizedStatus === "paid" || normalizedStatus === "failed")) {
      await sendTelegramNotification(formatContributionTelegramMessage(contribution, normalizedStatus, paymentReference)).catch(() => null);
    }
    return await getContributionById(contribution.id);
  } catch (e) {
    console.error("syncContributionWithBillplz error:", e.message);
    return contribution;
  }
}

app.use(express.json({ limit: "1mb" }));

// Enable CORS for all origins (required when frontend and API ports differ)
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (_req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.set("supabase", supabase);

app.get("/thank-you", (_req, res) => {
  res.sendFile(path.join(__dirname, "thank-you.html"));
});

app.post("/api/contributions/create-bill", async (req, res) => {
  const { createContributionBill } = await import("./contribution-api.js");
  return createContributionBill(req, res);
});

app.post("/api/contributions/webhook", express.text({ type: "*/*" }), async (req, res) => {
  req.rawBody = req.body || "";
  const { contributionWebhook } = await import("./contribution-api.js");
  return contributionWebhook(req, res);
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, db: Boolean(supabase) });
});

app.post("/api/contributions/:projectKey/checkout", async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const project = await getProject(req.params.projectKey);
    const {
      contributorName,
      phoneNumber,
      message,
      amount,
      giftItemId,
    } = req.body || {};

    const cleanedName = String(contributorName || "").trim();
    const cleanedPhone = String(phoneNumber || "").trim();
    const billplzMobile = normalizeBillplzMobile(cleanedPhone);
    const cleanedMessage = String(message || "").trim();
    const numericAmount = Number(amount || 0);

    if (!cleanedName) return res.status(400).json({ error: "Contributor name is required." });
    if (!cleanedPhone) return res.status(400).json({ error: "Phone number is required." });
    if (billplzMobile.length < 10 || billplzMobile.length > 13) {
      return res.status(400).json({ error: "Phone number format is invalid. Use Malaysian mobile format like 0123456789." });
    }
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: "Amount must be more than zero." });
    }

    const insertPayload = {
      contributor_name: cleanedName,
      message: cleanedMessage,
      amount: numericAmount,
      status: "pending",
      gift_item_id: giftItemId || null,
      contributor_email: "",
    };

    const { data: insertedRows, error: insertErr } = await supabase
      .from("gift_contributions")
      .insert(insertPayload)
      .select("id")
      .limit(1);
    if (insertErr) throw insertErr;
    const contributionId = insertedRows?.[0]?.id;
    if (!contributionId) throw new Error("Failed to create contribution record.");

    const origin = getRequestOrigin(req);
    const callbackUrl = `${origin}/api/contributions/${encodeURIComponent(project.project_key)}/billplz-callback?contributionId=${encodeURIComponent(contributionId)}`;
    const redirectUrl = `${origin}/contribution/thank-you?contributionId=${encodeURIComponent(contributionId)}`;
    const description = `E-Kaut contribution (${project.project_key}) #${contributionId}`;

    const bill = await createBillplzBill({
      amount: numericAmount,
      name: cleanedName,
      phone: billplzMobile,
      description,
      callbackUrl,
      redirectUrl,
    });

    // Best-effort metadata update for whichever bill id column exists in this database.
    if (bill?.billId) {
      const withBillplzCol = await supabase
        .from("gift_contributions")
        .update({ billplz_bill_id: bill.billId })
        .eq("id", contributionId);
      if (withBillplzCol.error) {
        await supabase
          .from("gift_contributions")
          .update({ toyyibpay_bill_code: bill.billId })
          .eq("id", contributionId);
      }
    }

    res.json({
      ok: true,
      contributionId,
      billId: bill.billId,
      paymentUrl: bill.paymentUrl,
      mode: isSandbox ? "sandbox" : "live",
      mock: Boolean(bill.isMock),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to create payment checkout." });
  }
});

app.post("/api/contributions/:projectKey/billplz-callback", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    console.log("[billplz-callback] Request body:", JSON.stringify(req.body));
    console.log("[billplz-callback] Query:", JSON.stringify(req.query));
    if (!requireDb(res)) return;
    const contributionId = String(req.query?.contributionId || "").trim();
    if (!contributionId) return res.status(400).send("Missing contributionId.");
    const fields = req.body || {};
    console.log("[billplz-callback] Signature key configured:", Boolean(process.env.BILLPLZ_X_SIGNATURE_KEY));
    console.log("[billplz-callback] x_signature present:", Boolean(fields.x_signature));
    const sigValid = verifyBillplzSignature(fields);
    console.log("[billplz-callback] Signature valid:", sigValid);
    if (!sigValid) return res.status(401).send("Invalid signature.");

    const paidRaw = String(fields.paid ?? "").toLowerCase();
    const stateRaw = String(fields.state ?? "").toLowerCase();
    const billId = String(fields.id ?? "").trim();
    const txId = String(fields.transaction_id ?? "").trim();
    const normalizedStatus = normalizeGatewayStatus(paidRaw === "true" ? "paid" : stateRaw || paidRaw);
    console.log("[billplz-callback] Bill ID:", billId, "- Normalized status:", normalizedStatus);
    const current = await getContributionById(contributionId);
    console.log("[billplz-callback] Contribution lookup result:", current ? "found" : "not found");
    if (!current) return res.status(404).send("Contribution not found.");
    const currentBillId = current.billplz_bill_id || current.toyyibpay_bill_code;
    if (currentBillId && billId && currentBillId !== billId) return res.status(409).send("Bill reference mismatch.");
    const resolvedReference = await resolveBillplzTransactionReference(
      billId || currentBillId || "",
      txId,
      normalizedStatus
    );
    await updateContributionStatus(contributionId, normalizedStatus, billId || currentBillId || "", resolvedReference);
    if (normalizedStatus !== current.status && (normalizedStatus === "paid" || normalizedStatus === "failed")) {
      await sendTelegramNotification(formatContributionTelegramMessage(current, normalizedStatus, resolvedReference)).catch(() => null);
    }

    res.status(200).send("OK");
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Callback failed.");
  }
});

app.get("/api/contributions/status/:id", async (req, res) => {
  try {
    console.log("[status-endpoint] Request received for ID:", req.params.id);
    if (!requireDb(res)) return;
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing contribution id." });
    console.log("[status-endpoint] Looking up contribution:", id);
    const contribution = await syncContributionWithBillplz(id);
    console.log("[status-endpoint] Sync result:", contribution ? `found, status=${contribution.status}` : "not found");
    if (!contribution) return res.status(404).json({ error: "Contribution not found." });
    res.json({
      id: contribution.id,
      status: contribution.status,
      paymentReference: contribution.payment_reference || null,
    });
  } catch (error) {
    console.error("[status-endpoint] Error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to fetch contribution status." });
  }
});

// Debug endpoint: test Supabase query directly
app.get("/api/debug/contribution/:id", async (req, res) => {
  try {
    console.log("[debug] Request for ID:", req.params.id);
    if (!supabase) return res.status(500).json({ error: "Supabase not initialized" });
    const id = String(req.params.id || "").trim();
    const { data, error } = await supabase
      .from("gift_contributions")
      .select("*")
      .eq("id", id)
      .single();
    if (error) {
      console.error("[debug] Supabase error:", JSON.stringify(error));
      return res.status(404).json({ error: error.message, details: error });
    }
    console.log("[debug] Found:", JSON.stringify(data));
    res.json(data);
  } catch (error) {
    console.error("[debug] Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/contribution/thank-you", async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const contributionId = String(req.query?.contributionId || req.query?.refno || "").trim();
    let contribution = contributionId ? await syncContributionWithBillplz(contributionId) : null;

    const redirectFields = {};
    for (const [key, value] of Object.entries(req.query || {})) {
      if (typeof value === "string" && value && (key.startsWith("billplz[") || key === "x_signature")) {
        redirectFields[key] = value;
      }
    }
    const redirectBillId = String(redirectFields["billplz[id]"] || "").trim();
    const redirectPaymentReference = String(redirectFields["billplz[transaction_id]"] || "").trim();
    const redirectStatus = normalizeGatewayStatus(
      redirectFields["billplz[state]"] || redirectFields["billplz[paid]"] || req.query?.status
    );

    if (
      contribution &&
      contribution.status === "pending" &&
      redirectStatus !== "pending" &&
      redirectBillId &&
      (contribution.billplz_bill_id || contribution.toyyibpay_bill_code) === redirectBillId &&
      verifyBillplzSignature(redirectFields)
    ) {
      const resolvedReference = await resolveBillplzTransactionReference(
        redirectBillId,
        redirectPaymentReference || contribution.payment_reference || "",
        redirectStatus
      );
      await updateContributionStatus(contribution.id, redirectStatus, redirectBillId, resolvedReference);
      contribution = await getContributionById(contribution.id);
    }

    const status =
      contribution?.status === "pending" && redirectStatus === "failed"
        ? "failed"
        : (contribution?.status ?? "pending");

    const title =
      status === "paid"
        ? "Thank you for your generous gift"
        : status === "failed"
          ? "Payment was not completed"
          : "Your contribution is being confirmed";
    const body =
      status === "paid"
        ? "Your contribution has been confirmed by our system."
        : status === "failed"
          ? "This payment was canceled or did not complete. You may return and try again."
          : "We are waiting for payment gateway callback to finalize your status.";

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Contribution Status</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf1e3;color:#121d6c;font-family:Arial,sans-serif}
    .card{width:min(92vw,560px);background:#fff8ee;border:2px solid #6f8466;border-radius:16px;padding:24px}
    h1{margin:0 0 10px;font-size:28px;line-height:1.2}
    p{margin:8px 0;line-height:1.5}
    .meta{font-size:14px;opacity:.9}
    a.btn{display:inline-block;margin-top:14px;background:#121d6c;color:#faf1e3;text-decoration:none;padding:10px 16px;border-radius:999px}
  </style>
</head>
<body>
  <main class="card">
    <h1>${title}</h1>
    <p>${body}</p>
    ${contribution ? `<p class="meta">Contribution reference: <strong>${contribution.id}</strong></p>` : ""}
    ${contribution?.payment_reference ? `<p class="meta">Billplz order number: <strong>${contribution.payment_reference}</strong></p>` : ""}
    <a class="btn" href="/">Return to invitation</a>
  </main>
  ${status === "pending" && contributionId ? `<script>
    setInterval(async function(){
      try{
        const r = await fetch('/api/contributions/status/${contributionId}');
        if(!r.ok) return;
        const d = await r.json();
        if(d && d.status && d.status !== 'pending'){ location.reload(); }
      }catch(e){}
    }, 5000);
  </script>` : ""}
</body>
</html>`;
    res.status(200).send(html);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Unable to load contribution status page.");
  }
});

app.post('/api/rsvp/:projectKey', async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const { fullName, attendance, pax, phoneNumber, message } = req.body || {};
    if (!fullName || !attendance) {
      return res.status(400).json({ error: 'Full name and attendance are required.' });
    }
    const isAttending = attendance === 'attending';
    const project = await getProject(req.params.projectKey);
    const payload = {
      project_id: project.id,
      full_name: String(fullName || '').trim(),
      attendance: String(attendance || '').trim(),
      pax: isAttending ? Math.min(Math.max(Number(pax || 1), 1), 8) : null,
      wish_message: typeof message === 'string' ? message.trim() : (typeof phoneNumber === 'string' ? phoneNumber.trim() : ''),
    };

    console.log('RSVP: Inserting payload:', JSON.stringify(payload, null, 2));
    const { data: inserted, error: insertErr } = await supabase.from('wc_rsvps').insert(payload).select();
    if (insertErr) {
      console.error('RSVP: Supabase insert error:', insertErr);
      throw insertErr;
    }
    console.log('RSVP: Successfully inserted:', JSON.stringify(inserted, null, 2));
    const saved = inserted?.[0] || payload;
    let totalAttendancePax = 0;
    try {
      const { data: attendingRows, error: attendingErr } = await supabase
        .from("wc_rsvps")
        .select("pax")
        .eq("project_id", project.id)
        .eq("attendance", "attending");
      if (!attendingErr && Array.isArray(attendingRows)) {
        totalAttendancePax = attendingRows.reduce((sum, row) => sum + Number(row?.pax || 0), 0);
      }
    } catch (_) {}
    await sendTelegramNotification(formatRsvpTelegramMessage(saved, totalAttendancePax)).catch(() => null);
    res.json({ ok: true, data: inserted });
  } catch (error) {
    console.error('RSVP: Unhandled error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to submit RSVP.' });
  }
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
    // Keep this endpoint aligned with E-Card 2nd Batch: read from gift_items.
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

    res.json({ source: "gift_items", items: [] });
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

    res.json({ source: "gift_items", items: [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to fetch admin gift items." });
  }
});

app.put("/api/admin/gift-items/:projectKey", async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    // Keep writes aligned with E-Card 2nd Batch: write to gift_items only.
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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to save admin gift items." });
  }
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
