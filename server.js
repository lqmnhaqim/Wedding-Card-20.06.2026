import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import cookieParser from "cookie-parser";
import { consumeRateLimit, setRateLimitDbClient } from "./rate-limit.js";
import crypto from "node:crypto";
import { z } from "zod";
import registerRsvpRoutes from "./routes/rsvp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = process.env.VERCEL_ENV ? process.cwd() : __dirname;

const app = express();
const PORT = Number(process.env.PORT || 8787);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } })
    : null;

if (supabase) setRateLimitDbClient(supabase);

const rawSandbox = String(process.env.BILLPLZ_SANDBOX || "").trim().replace(/^["']|["']$/g, "").toLowerCase();
const isSandbox = rawSandbox === "true";
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

// --- HTML Escaping (F7) ---
function escapeHtml(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (ch) => map[ch]);
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
    const paidFromContrib = rows.filter(r => {
      const s = (r.status || "").toLowerCase();
      return s === "paid" || s === "success" || s === "completed";
    }).reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const fundedAmount = dbFundedAmount > 0 ? dbFundedAmount : paidFromContrib;
    const status = (item.status || "").toLowerCase();
    const isFullyFunded = status === "fully_funded" || (targetAmount > 0 && fundedAmount >= targetAmount);
    return {
      id: item.id,
      title: escapeHtml(item.title || "Gift Item"),
      description: escapeHtml(item.description || ""),
      imageUrl: item.image_url || "",
      contributorNames: contributorNames.map(escapeHtml),
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
    const paidFromContrib = rows.filter(r => {
      const s = (r.status || "").toLowerCase();
      return s === "paid" || s === "success" || s === "completed";
    }).reduce((sum, r) => sum + Number(r.amount || 0), 0);
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
    .map(([key, value]) => `${key}${value ?? ""}`)
    .join("");

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

async function formatContributionTelegramMessage(contribution, status, paymentReference) {
  const isPaid = status === "paid";
  const name = escapeTelegramHtml(contribution?.contributor_name ?? "Guest");
  const amount = escapeTelegramHtml(String(contribution?.amount ?? "-"));
  const orderNo = escapeTelegramHtml(paymentReference || "-");

  let giftBlock = "";
  const giftItemId = contribution?.gift_item_id;
  if (giftItemId && isPaid) {
    try {
      const { data: gift } = await supabase.from("gift_items").select("title,target_amount").eq("id", giftItemId).single();
      if (gift) {
        const { data: paidRows } = await supabase.from("gift_contributions").select("amount").eq("gift_item_id", giftItemId).in("status", ["paid", "success", "completed"]);
        const fundedNow = (paidRows || []).reduce((s, r) => s + Number(r.amount || 0), 0);
        const target = Number(gift.target_amount || 0);
        const progressPct = target > 0 ? Math.min(Math.round((fundedNow / target) * 10), 10) : 0;
        const bar = "\u2593".repeat(progressPct) + "\u2591".repeat(10 - progressPct);
        giftBlock = `\n🎁 <b>Gift</b>: ${escapeTelegramHtml(gift.title)}\n📊 <b>Progress</b>: <code>${bar}</code> RM ${fundedNow} / RM ${target}\n`;
      }
    } catch (_) { /* best effort */ }
  }

  if (isPaid) {
    return (
      `✅ <b>Payment Received!</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Name</b>: ${name}\n` +
      `💵 <b>Amount</b>: RM ${amount}\n` +
      giftBlock +
      `🔢 <b>Order</b>: <code>${orderNo}</code>\n` +
      `━━━━━━━━━━━━━━━━`
    );
  }
  return (
    `❌ <b>Payment Failed</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Name</b>: ${name}\n` +
    `💵 <b>Amount</b>: RM ${amount}\n` +
    `🔢 <b>Order</b>: <code>${orderNo}</code>\n` +
    `━━━━━━━━━━━━━━━━`
  );
}

async function getContributionById(contributionId) {
  if (!contributionId) return null;
  const { data, error } = await supabase
    .from("gift_contributions")
    .select("*")
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
  console.log("[sync] Starting sync for:", contributionId);
  console.log("[sync] Supabase client exists:", Boolean(supabase));
  
  const contribution = await getContributionById(contributionId);
  console.log("[sync] getContributionById returned:", contribution ? `found ${contribution.contributor_name}` : "null");
  
  if (!contribution) return null;
  const billId = contribution.billplz_bill_id || contribution.toyyibpay_bill_code;
  console.log("[sync] Bill ID to check:", billId || "none");
  
  if (!billId) {
    console.log("[sync] No billId for contribution:", contributionId);
    return contribution;
  }
  
  console.log("[sync] Checking Billplz bill:", billId);
  console.log("[sync] Billplz sandbox:", isSandbox);
  
  try {
    const remote = await getBillplzBillStatus(billId);
    console.log("[sync] Remote response:", remote ? JSON.stringify(remote) : "null");
    
    if (!remote) return contribution;
    const remotePaid = remote.paid === true || remote.paid === "true";
    const remoteState = remote.state ? String(remote.state).toLowerCase() : "unknown";
    console.log("[sync] paid:", remotePaid, "- state:", remoteState);
    
    const normalizedStatus = remotePaid ? "paid" : normalizeGatewayStatus(remoteState);
    console.log("[sync] Normalized status:", normalizedStatus);
    
    const paymentReference = await resolveBillplzTransactionReference(
      billId,
      String(remote.transaction_id ?? contribution.payment_reference ?? ""),
      normalizedStatus
    );
    
    if (
      normalizedStatus === contribution.status &&
      paymentReference === String(contribution.payment_reference ?? "")
    ) {
      console.log("[sync] No change needed, returning existing");
      return contribution;
    }
    
    await updateContributionStatus(contribution.id, normalizedStatus, billId, paymentReference);
    if (normalizedStatus !== contribution.status && (normalizedStatus === "paid" || normalizedStatus === "failed")) {
      await sendTelegramNotification(await formatContributionTelegramMessage(contribution, normalizedStatus, paymentReference)).catch(() => null);
    }
    const updated = await getContributionById(contribution.id);
    console.log("[sync] After update, status:", updated?.status);
    return updated;
  } catch (e) {
    console.error("[sync] Error:", e.message, e.stack);
    return contribution;
  }
}

app.use(cookieParser());

app.use((req, res, next) => {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "DELETE") return next();
  if (req.path === "/api/contributions/webhook") return next();
  if (req.path.endsWith("/billplz-callback")) return next();
  return verifyCsrfToken(req, res, next);
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// Enable CORS for configured origin + localhost fallback
app.use((_req, res, next) => {
  const configuredOrigin = String(process.env.APP_BASE_URL || "").trim();
  const allowedOrigin = configuredOrigin
    ? configuredOrigin.replace(/\/$/, "")
    : `${_req.protocol}://${_req.get("host")}`;
  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization,x-csrf-token,x-admin-token");
  if (_req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.set("supabase", supabase);
app.set("getOrigin", getRequestOrigin);

// --- Error Sanitization (F9) ---
function sanitizeApiError(error) {
  if (error instanceof z.ZodError) {
    const issues = error.issues || error.errors || [];
    return issues.map(e => `${(e.path || []).join(".")}: ${e.message}`).join("; ");
  }
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("Please enter") || msg.includes("Sila masukkan") ||
        msg.includes("Unable to") || msg.includes("Tidak dapat") ||
        msg.includes("Payment URL") || msg.includes("Pautan pembayaran") ||
        msg.includes("This gift has") || msg.includes("Hadiah ini") ||
        msg.includes("required") || msg.includes("must be") ||
        msg.includes("invalid") || msg.includes("Valid")) {
      return msg;
    }
  }
  return "An unexpected error occurred. Please try again later.";
}

// --- Zod Validation Schemas (F8) ---

const rsvpSchema = z.object({
  fullName: z.string().min(2, "Full name is required (minimum 2 characters)."),
  attendance: z.enum(["attending", "not_attending"], { errorMap: () => ({ message: "Attendance must be 'attending' or 'not_attending'." }) }),
  pax: z.number().int().min(1).max(8).optional(),
  phoneNumber: z.string().optional(),
  message: z.string().optional(),
});

const contributionSchema = z.object({
  contributorName: z.string().min(2, "Name must be at least 2 characters."),
  message: z.string().optional().default(""),
  amount: z.number().min(1, "Amount must be at least RM 1.").max(100000, "Amount cannot exceed RM 100,000."),
  email: z.string().optional().default(""),
  phoneNumber: z.string().min(6, "Valid phone number required."),
  giftItemId: z.string().optional(),
});

const checkoutSchema = z.object({
  contributorName: z.string().min(2, "Contributor name is required."),
  phoneNumber: z.string().min(8, "Phone number is required (minimum 8 characters)."),
  message: z.string().optional().default(""),
  amount: z.number().min(1, "Amount must be more than zero.").max(100000, "Amount cannot exceed RM 100,000."),
  giftItemId: z.string().optional(),
});

const settingsSchema = z.object({
  settings: z.record(z.unknown()),
  is_published: z.boolean().optional(),
});

const giftItemsSchema = z.object({
  source: z.string().optional(),
  items: z.array(z.object({
    id: z.string().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    imageUrl: z.string().optional(),
    productUrl: z.string().optional(),
    targetAmount: z.number().optional(),
    fundedAmount: z.number().optional(),
    status: z.string().optional(),
  })),
});

// --- Security Headers ---
app.use((_req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// --- Admin Authentication Middleware ---

function decodeBasicAuth(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const encoded = header.slice("Basic ".length).trim();
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hasWeakCredentials(username, password) {
  const KNOWN_WEAK = new Set(["admin:admin", "admin:password", "root:root"]);
  const pair = `${username.trim().toLowerCase()}:${password.trim().toLowerCase()}`;
  if (KNOWN_WEAK.has(pair)) return true;
  return username.trim().toLowerCase() === password.trim().toLowerCase();
}

function basicAuthRequired(req, res, next) {
  const username = String(process.env.ADMIN_USERNAME || "").trim();
  const password = String(process.env.ADMIN_PASSWORD || "").trim();

  if (!username || !password) {
    if (process.env.NODE_ENV !== "production") return next();
    return res.status(503).json({ error: "Admin authentication is not configured." });
  }

  if (process.env.NODE_ENV === "production" && hasWeakCredentials(username, password)) {
    return res.status(503).json({ error: "Admin authentication must use stronger credentials." });
  }

  const auth = decodeBasicAuth(req.headers.authorization || "");
  if (!auth) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Wedding Admin", charset="UTF-8"');
    return res.status(401).json({ error: "Authentication required." });
  }

  if (!safeEqual(auth.username, username) || !safeEqual(auth.password, password)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Wedding Admin", charset="UTF-8"');
    return res.status(401).json({ error: "Authentication required." });
  }

  next();
}

// --- CSRF Protection (HMAC-SHA256 signed tokens, ported from E-Card 2nd Batch) ---

function getCsrfSecret() {
  const secret = String(process.env.CSRF_SECRET || "").trim();
  if (secret) return secret;
  if (process.env.NODE_ENV !== "production") return "development-only-csrf-secret-do-not-use-in-production";
  console.error("CRITICAL: CSRF_SECRET not configured in production. Set it in Vercel Dashboard.");
  return "MISSING-CSRF-SECRET-" + Date.now();
}

function csrfHmac(value) {
  return crypto.createHmac("sha256", getCsrfSecret()).update(value).digest("hex");
}

function generateCsrfToken() {
  const raw = crypto.randomBytes(32).toString("hex");
  return `${raw}:${csrfHmac(raw)}`;
}

function validateCsrfTokenFormat(token) {
  const sep = token.indexOf(":");
  if (sep === -1) return false;
  const raw = token.slice(0, sep);
  const sig = token.slice(sep + 1);
  return csrfHmac(raw) === sig;
}

function getCsrfCookieName() {
  return "wc_csrf_token";
}

function verifyCsrfToken(req, res, next) {
  const headerToken = String(req.headers["x-csrf-token"] || "").trim();
  if (!headerToken) return res.status(403).json({ error: "Missing CSRF token header." });

  const cookieToken = String(req.cookies?.[getCsrfCookieName()] || "").trim();
  if (!cookieToken) return res.status(403).json({ error: "Missing CSRF cookie." });

  if (headerToken !== cookieToken) return res.status(403).json({ error: "CSRF token mismatch." });

  if (!validateCsrfTokenFormat(headerToken)) return res.status(403).json({ error: "Invalid CSRF token format." });

  next();
}

function attachCsrfCookie(req, res, next) {
  const existingToken = req.cookies?.[getCsrfCookieName()];
  const token = existingToken && validateCsrfTokenFormat(existingToken) ? existingToken : generateCsrfToken();
  res.cookie(getCsrfCookieName(), token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24,
  });
  res.setHeader("X-CSRF-Token", token);
  next();
}

function sameOrigin(left, right) {
  try { return new URL(left).origin === new URL(right).origin; }
  catch { return false; }
}

function ensureTrustedWriteOrigin(req, res, next) {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "DELETE") return next();

  const requestOrigin = `${req.protocol}://${req.get("host")}`;
  const origin = req.get("origin");
  if (origin && !sameOrigin(origin, requestOrigin)) {
    return res.status(403).json({ error: "Blocked cross-site request." });
  }
  const referer = req.get("referer");
  if (referer && !sameOrigin(referer, requestOrigin)) {
    return res.status(403).json({ error: "Blocked cross-site request." });
  }
  next();
}

app.get("/", attachCsrfCookie, (_req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.get("/thank-you", attachCsrfCookie, (_req, res) => {
  res.sendFile(path.join(rootDir, "thank-you.html"));
});

app.post("/api/contributions/create-bill", async (req, res) => {
  const { createContributionBill } = await import("./contribution-api.js");
  return createContributionBill(req, res);
});

app.post("/api/contributions/webhook", express.urlencoded({ extended: false, type: "*/*" }), async (req, res) => {
  req.rawBody = Object.entries(req.body || {}).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  const { contributionWebhook } = await import("./contribution-api.js");
  return contributionWebhook(req, res);
});

app.get("/admin", basicAuthRequired, attachCsrfCookie, (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.sendFile(path.join(rootDir, "admin.html"));
});

function verifyAdminToken(req, res, next) {
  const token = String(req.headers["x-admin-token"] || "").trim();
  if (!token) return res.status(401).json({ error: "Missing admin token." });
  const session = req.cookies?.["admin_session"];
  if (!session || token !== session) return res.status(401).json({ error: "Invalid admin token." });
  next();
}

app.get("/api/admin/token", (_req, res) => {
  const token = crypto.randomBytes(16).toString("hex");
  res.cookie("admin_session", token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/admin",
    maxAge: 1000 * 60 * 60 * 8,
  });
  res.json({ token });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, db: Boolean(supabase) });
});

registerRsvpRoutes(app);

app.post("/api/contributions/:projectKey/checkout", async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const project = await getProject(req.params.projectKey);
    const parsed = checkoutSchema.parse(req.body || {});

    const billplzMobile = normalizeBillplzMobile(parsed.phoneNumber.trim());
    if (billplzMobile.length < 10 || billplzMobile.length > 13) {
      return res.status(400).json({ error: "Phone number format is invalid. Use Malaysian mobile format like 0123456789." });
    }

    const insertPayload = {
      contributor_name: parsed.contributorName.trim(),
      message: (parsed.message || "").trim(),
      amount: parsed.amount,
      status: "pending",
      gift_item_id: parsed.giftItemId || null,
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
    const status = error instanceof z.ZodError ? 400 : 500;
    res.status(status).json({ error: sanitizeApiError(error) });
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
    const currentBillId = (current.billplz_bill_id || current.toyyibpay_bill_code || "").trim();
    if (!currentBillId) return res.status(400).send("Contribution has no associated bill reference.");
    if (!billId) return res.status(400).send("Missing bill ID in callback.");
    if (currentBillId !== billId) return res.status(409).send("Bill reference mismatch.");
    const resolvedReference = await resolveBillplzTransactionReference(
      billId || currentBillId || "",
      txId,
      normalizedStatus
    );
    await updateContributionStatus(contributionId, normalizedStatus, billId || currentBillId || "", resolvedReference);
    if (normalizedStatus !== current.status && (normalizedStatus === "paid" || normalizedStatus === "failed")) {
      await sendTelegramNotification(await formatContributionTelegramMessage(current, normalizedStatus, resolvedReference)).catch(() => null);
    }

    res.status(200).send("OK");
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Callback failed.");
  }
});

app.get("/api/contributions/status/:id", async (req, res) => {
  try {
    console.log("[status] Request received, ID:", req.params.id);
    if (!requireDb(res)) return;
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing contribution id." });
    const result = await syncContributionWithBillplz(id);
    if (!result) return res.status(404).json({ error: "Contribution not found." });
    res.json({
      id: result.id,
      status: result.status,
      paymentReference: result.payment_reference || null,
    });
  } catch (error) {
    console.error("[status] Error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to fetch contribution status." });
  }
});

// Debug endpoint: test Supabase query directly
app.get("/contribution/thank-you", async (req, res) => {
  try {
    if (!requireDb(res)) {
      return res.sendFile(path.join(rootDir, "thank-you.html"));
    }
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
        ? "Your contribution has been confirmed and will appear in our records."
        : status === "failed"
          ? "This payment was canceled or did not complete. You may return and try again."
          : "We are waiting for the payment gateway to finalize your contribution. Please wait a moment.";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Thank You - Wedding Gift</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Anton&family=Playfair+Display:wght@400;500;700&display=swap" rel="stylesheet" />
  <style>
    :root { --blue: #121d6c; --paper: #fffdf6; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: var(--blue); font-family: "Playfair Display", serif; color: var(--blue);
    }
    .card {
      background: rgba(255,253,246,0.96); border-radius: 24px; padding: 48px 40px;
      max-width: 560px; width: calc(100% - 32px); text-align: center; box-shadow: 0 28px 90px rgba(0,0,0,0.34);
    }
    h1 { font-family: "Anton", sans-serif; font-size: 36px; line-height: 1.1; margin-bottom: 14px; }
    p { font-size: 16px; line-height: 1.5; color: #3a3a3a; margin-bottom: 12px; }
    .meta { font-size: 13px; color: #777; margin-top: 24px; padding-top: 20px; border-top: 1px solid #e0d6c2; }
    .meta strong { color: var(--blue); }
    .button {
      display: inline-flex; align-items: center; justify-content: center;
      height: 44px; padding: 0 28px; border: 2px solid var(--blue); border-radius: 1000px;
      background: var(--blue); color: rgba(255,253,246,0.96);
      font: 400 14px/1 "Playfair Display", serif; text-decoration: none;
      margin-top: 20px; transition: opacity .18s;
    }
    .button:hover { opacity: 0.88; }
    .spinner {
      display: inline-block; width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; margin-right: 8px; vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hidden { display: none; }
  </style>
</head>
<body>
  <main class="card">
    <h1 id="headline">${title}</h1>
    <p id="message">${body}</p>
    <div id="meta" class="meta${contributionId ? "" : " hidden"}">
      ${contribution ? `<p>Contribution reference: <strong>${escapeHtml(contribution.id)}</strong></p>` : ""}
      ${contribution?.payment_reference ? `<p>Payment reference: <strong>${escapeHtml(contribution.payment_reference)}</strong></p>` : ""}
    </div>
    <a class="button" href="/">Return to invitation</a>
  </main>
  ${status === "pending" && contributionId ? `<script>
    (function() {
      var contributionId = "${contributionId}";
      var ref = "";
      var attempts = 0;
      var maxAttempts = 8;
      function pollStatus() {
        if (!contributionId) return;
        attempts += 1;
        fetch("/api/contributions/status/" + encodeURIComponent(contributionId))
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(data) {
            if (!data) return;
            if (data.status === "paid" || data.status === "failed") {
              if (data.status === "paid") {
                document.getElementById("headline").textContent = "Thank you for your generous gift";
                document.getElementById("message").textContent = "Your contribution has been confirmed and will appear in our records.";
              } else {
                document.getElementById("headline").textContent = "Payment was not completed";
                document.getElementById("message").textContent = "This payment was canceled or did not complete. You may return to the invitation and try again.";
              }
              if (data.paymentReference && !ref) {
                ref = data.paymentReference;
                document.getElementById("meta").classList.remove("hidden");
                document.getElementById("meta").innerHTML = '<p>Contribution reference: <strong>' + contributionId + '</strong></p><p>Payment reference: <strong>' + ref + '</strong></p>';
              }
              return;
            }
            if (attempts < maxAttempts) setTimeout(pollStatus, 3000);
          })
          .catch(function() {
            if (attempts < maxAttempts) setTimeout(pollStatus, 3000);
          });
      }
      pollStatus();
    })();
  </script>` : ""}
</body>
</html>`;
    res.status(200).send(html);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Unable to load contribution status page.");
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

app.put("/api/settings/:projectKey", verifyAdminToken, verifyCsrfToken, async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const project = await getProject(req.params.projectKey);
    const parsed = settingsSchema.parse(req.body || {});
    const payload = {
      project_id: project.id,
      settings: parsed.settings || {},
      is_published: parsed.is_published !== false
    };
    const { error } = await supabase
      .from("wc_site_settings")
      .upsert(payload, { onConflict: "project_id" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 500;
    res.status(status).json({ error: sanitizeApiError(error) });
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

app.get("/api/admin/gift-items/:projectKey", verifyAdminToken, async (req, res) => {
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

app.put("/api/admin/gift-items/:projectKey", verifyAdminToken, verifyCsrfToken, async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const parsed = giftItemsSchema.parse(req.body || {});
    const payload = parsed.items
      .map((item) => ({
        id: item.id || undefined,
        title: String(item.title || "").trim(),
        description: String(item.description || "").trim(),
        image_url: String(item.imageUrl || "").trim(),
        product_url: String(item.productUrl || "").trim(),
        target_amount: Number(item.targetAmount || 0),
        status: String(item.status || "available").trim() || "available"
      }))
      .filter((item) => item.title);

    if (payload.length) {
      const { error } = await supabase.from("gift_items").upsert(payload, { onConflict: "id" });
      if (error) throw error;
    }
    res.json({ ok: true, source: "gift_items" });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 500;
    res.status(status).json({ error: sanitizeApiError(error) });
  }
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
