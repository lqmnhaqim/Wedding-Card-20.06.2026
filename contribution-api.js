import { consumeRateLimitSync } from "./rate-limit.js";
import { z } from "zod";

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 10 * 60 * 1000;

const dupCache = new Map();
const DUP_WINDOW_MS = 10_000;

function escapeTelegramHtml(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (ch) => map[ch]);
}

export async function sendTelegramNotification(message) {
  const enabled = process.env.TELEGRAM_ENABLED !== "false";
  console.log("[Telegram] enabled:", enabled);
  if (!enabled) return;
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  console.log("[Telegram] bot token configured:", Boolean(botToken), "chat ID configured:", Boolean(chatId));
  if (!botToken || !chatId) return;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
  });
  const tgBody = await res.text().catch(() => "");
  console.log("[Telegram] response status:", res.status, "body:", tgBody.slice(0, 200));
  if (!res.ok) console.error("Telegram send failed:", tgBody);
}

export async function formatContributionTelegramMessage(contribution, status, paymentReference, supabase) {
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

function checkDedup(clientId) {
  const now = Date.now();
  const existing = dupCache.get(clientId);
  if (existing && now - existing < DUP_WINDOW_MS) return false;
  dupCache.set(clientId, now);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - DUP_WINDOW_MS;
  for (const [k, v] of dupCache) { if (v < cutoff) dupCache.delete(k); }
}, 30_000);

function sanitizeError(error) {
  if (error instanceof z.ZodError) {
    const issues = error.issues || error.errors || [];
    return issues.map(e => `${(e.path || []).join(".")}: ${e.message}`).join("; ");
  }
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("Please enter") || msg.includes("must be") ||
        msg.includes("required") || msg.includes("Unable to") ||
        msg.includes("This gift has") || msg.includes("remaining") ||
        msg.includes("fully funded") || msg.includes("Valid")) {
      return msg;
    }
  }
  return "An unexpected error occurred. Please try again later.";
}

const contributionBodySchema = z.object({
  contributorName: z.string().min(2, "Name must be at least 2 characters."),
  message: z.string().optional().default(""),
  amount: z.number().min(1, "Amount must be at least RM 1.").max(100000, "Amount cannot exceed RM 100,000."),
  email: z.string().optional().default(""),
  phoneNumber: z.string().min(6, "Valid phone number required."),
  giftItemId: z.string().optional(),
});

export async function createContributionBill(req, res) {
  try {
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const rl = await consumeRateLimitSync(`contribution:${clientIp}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
    if (!rl.ok) {
      return res.status(429).json({ error: "Too many contribution attempts. Please try again shortly." });
    }

    const dedupKey = `${clientIp}:${Math.floor(Date.now() / DUP_WINDOW_MS)}`;
    if (!checkDedup(dedupKey)) {
      return res.status(429).json({ error: "Duplicate contribution detected. Please wait before trying again." });
    }

    const { contributorName, message, amount, email, phoneNumber, giftItemId } = contributionBodySchema.parse(req.body || {});

    const { createBillplzBill } = await import("./billplz.js");
    const supabase = req.app.get("supabase");
    if (!supabase) return res.status(500).json({ error: "Database not available." });

    let giftTitle = "";
    if (giftItemId) {
      const { data: giftItem } = await supabase.from("gift_items").select("id,title,target_amount").eq("id", giftItemId).single();
      if (!giftItem) return res.status(404).json({ error: "Gift item not found." });
      const { data: paidRows } = await supabase.from("gift_contributions").select("amount").eq("gift_item_id", giftItemId).in("status", ["paid", "success", "completed"]);
      const fundedAmount = (paidRows || []).reduce((s, r) => s + Number(r.amount || 0), 0);
      const remaining = Math.max(Number(giftItem.target_amount || 0) - fundedAmount, 0);
      if (remaining <= 0) return res.status(400).json({ error: "This gift has already been fully funded." });
      if (Number(amount) > remaining) return res.status(400).json({ error: `This gift has only RM ${remaining.toFixed(0)} remaining.` });
      giftTitle = giftItem.title;
    }

    const { data: draft, error: insertErr } = await supabase
      .from("gift_contributions")
      .insert({
        contributor_name: String(contributorName).trim(),
        message: String(message || "").trim(),
        amount: Number(amount),
        status: "pending",
        gift_item_id: giftItemId || null,
      })
      .select()
      .single();

    if (insertErr || !draft) {
      console.error("Supabase insert error:", JSON.stringify(insertErr, null, 2));
      throw insertErr || new Error("Failed to create contribution record.");
    }

    const origin = req.app.get("getOrigin")
      ? req.app.get("getOrigin")(req)
      : `${req.protocol}://${req.get("host")}`;
    const billDescription = giftTitle ? `Wedding Gift - ${giftTitle} (${draft.id})` : `Salam E-Kaut (${draft.id})`;

    const paymentRequest = await createBillplzBill({
      amount: Number(amount),
      name: String(contributorName).trim(),
      email: email || undefined,
      phone: phoneNumber || undefined,
      description: billDescription,
      redirectUrl: `${origin}/thank-you?contributionId=${draft.id}`,
      callbackUrl: `${origin}/api/contributions/webhook?contributionId=${draft.id}`,
    });

    console.log("[createBill] Origin:", origin);
    console.log("[createBill] Callback URL:", `${origin}/api/contributions/webhook?contributionId=xxx`);

    const { error: updateErr } = await supabase
      .from("gift_contributions")
      .update({ billplz_bill_id: paymentRequest.billId, status: "pending" })
      .eq("id", draft.id);
    if (updateErr) console.error("Failed to update contribution bill ID:", updateErr);

    const paymentUrl = paymentRequest.isMock
      ? `${origin}/thank-you?contributionId=${draft.id}`
      : paymentRequest.paymentUrl;

const sandboxMode = String(process.env.BILLPLZ_SANDBOX || "").trim().replace(/^["']|["']$/g, "").toLowerCase() === "true";
    return res.json({ success: true, contributionId: draft.id, requestId: paymentRequest.billId, paymentUrl, mode: sandboxMode ? "sandbox" : "live" });
  } catch (error) {
    console.error("createContributionBill error:", error);
    const status = error instanceof z.ZodError ? 400 : 500;
    return res.status(status).json({ error: sanitizeError(error) });
  }
}

export async function contributionWebhook(req, res) {
  try {
    const { verifyBillplzCallbackSignature, getBillplzBillTransactions } = await import("./billplz.js");
    const supabase = req.app.get("supabase");
    if (!supabase) return res.status(500).json({ error: "Database not available." });

    const contributionId = req.query.contributionId || "";
    if (!contributionId) return res.status(400).json({ error: "Missing contribution reference." });

    const rawBody = req.rawBody || "";
    const fields = Object.fromEntries(new URLSearchParams(rawBody).entries());

    if (!verifyBillplzCallbackSignature(fields)) {
      return res.status(401).json({ error: "Invalid Billplz signature." });
    }

    const requestId = String(fields.id || "");
    const paymentReference = String(fields.transaction_id || "");
    const gatewayPaid = fields.paid === "true";
    const gatewayState = String(fields.state || "");

    const { data: contribution } = await supabase.from("gift_contributions").select("*").eq("id", contributionId).single();
    if (!contribution) return res.status(404).json({ error: "Contribution not found." });

    const storedBillId = (contribution.billplz_bill_id || contribution.toyyibpay_bill_code || "").trim();
    if (!storedBillId) return res.status(400).json({ error: "Contribution has no associated bill reference." });
    if (storedBillId !== requestId) return res.status(409).json({ error: "Bill reference mismatch." });

    const normalizedStatus = gatewayPaid || gatewayState.toLowerCase() === "completed" ? "paid"
      : gatewayState.toLowerCase() === "failed" || gatewayState.toLowerCase() === "deleted" || gatewayState.toLowerCase() === "due" ? "failed"
      : "pending";

    let resolvedRef = paymentReference;
    if (!resolvedRef) {
      try {
        const transactions = await getBillplzBillTransactions(requestId);
        const preferredStatus = normalizedStatus === "paid" ? "completed" : normalizedStatus === "failed" ? "failed" : "";
        const preferred = preferredStatus ? transactions.find((t) => t.status?.toLowerCase() === preferredStatus) : undefined;
        const latest = [...transactions].filter((t) => t.id).sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0))[0];
        resolvedRef = String(preferred?.id ?? latest?.id ?? "");
      } catch (e) {
        console.error("Failed to resolve transaction reference:", e);
      }
    }

    const { error: updateErr } = await supabase
      .from("gift_contributions")
      .update({ status: normalizedStatus, payment_reference: resolvedRef })
      .eq("id", contributionId);
    if (updateErr) console.error("Failed to update contribution status:", updateErr);

    if (normalizedStatus !== contribution.status && (normalizedStatus === "paid" || normalizedStatus === "failed")) {
      console.log("[Webhook] Status changed:", contribution.status, "→", normalizedStatus, ". Sending Telegram notification...");
      const contributionMsg = await formatContributionTelegramMessage(contribution, normalizedStatus, resolvedRef, supabase);
      console.log("[Webhook] Notification message:", contributionMsg.slice(0, 100));
      await sendTelegramNotification(contributionMsg).catch(() => null);
    } else {
      console.log("[Webhook] No status change or not paid/failed. Old:", contribution.status, "New:", normalizedStatus);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("contributionWebhook error:", error);
    return res.status(500).json({ error: sanitizeError(error) });
  }
}
