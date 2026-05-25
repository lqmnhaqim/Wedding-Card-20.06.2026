import { consumeRateLimit } from "./rate-limit.js";

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 10 * 60 * 1000;

export async function createContributionBill(req, res) {
  try {
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const rl = consumeRateLimit(`contribution:${clientIp}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
    if (!rl.ok) {
      return res.status(429).json({ error: "Too many contribution attempts. Please try again shortly." });
    }

    const { contributorName, message, amount, email, phoneNumber, giftItemId } = req.body || {};
    if (!contributorName || contributorName.length < 2) {
      return res.status(400).json({ error: "Name must be at least 2 characters." });
    }
    if (!amount || !Number.isFinite(Number(amount)) || Number(amount) < 1) {
      return res.status(400).json({ error: "Amount must be at least RM 1." });
    }
    if (Number(amount) > 100000) {
      return res.status(400).json({ error: "Amount cannot exceed RM 100,000." });
    }
    if (!phoneNumber || String(phoneNumber).trim().length < 8) {
      return res.status(400).json({ error: "Valid phone number required." });
    }

    const { createBillplzBill } = await import("./billplz.js");
    const supabase = req.app.get("supabase");
    if (!supabase) return res.status(500).json({ error: "Database not available." });

    let giftTitle = "";
    if (giftItemId) {
      const { data: giftItem } = await supabase.from("gift_items").select("id,title,target_amount,funded_amount").eq("id", giftItemId).single();
      if (!giftItem) return res.status(404).json({ error: "Gift item not found." });
      const remaining = Math.max(Number(giftItem.target_amount || 0) - Number(giftItem.funded_amount || 0), 0);
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

    const origin = `${req.protocol}://${req.get("host")}`;
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

    const { error: updateErr } = await supabase
      .from("gift_contributions")
      .update({ billplz_bill_id: paymentRequest.billId, status: "pending" })
      .eq("id", draft.id);
    if (updateErr) console.error("Failed to update contribution bill ID:", updateErr);

    const paymentUrl = paymentRequest.isMock
      ? `${origin}/thank-you?contributionId=${draft.id}`
      : paymentRequest.paymentUrl;

    return res.json({ success: true, contributionId: draft.id, requestId: paymentRequest.billId, paymentUrl, mode: process.env.BILLPLZ_SANDBOX === "true" ? "sandbox" : "live" });
  } catch (error) {
    console.error("createContributionBill error:", error);
    return res.status(400).json({ error: error instanceof Error ? error.message : "Unable to create payment request." });
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
    if (contribution.billplz_bill_id !== requestId) return res.status(409).json({ error: "Bill reference mismatch." });

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

    return res.json({ success: true });
  } catch (error) {
    console.error("contributionWebhook error:", error);
    return res.status(500).json({ error: "Webhook processing failed." });
  }
}
