import crypto from "node:crypto";

const rawSandbox = process.env.BILLPLZ_SANDBOX?.trim();
const isSandbox = rawSandbox === "true" || rawSandbox === true || rawSandbox === "'true'" || rawSandbox === '"true"';

const billplzBaseUrl = isSandbox
  ? "https://www.billplz-sandbox.com/api"
  : "https://www.billplz.com/api";

export function getBillplzMode() {
  return isSandbox ? "sandbox" : "live";
}

function getBillplzAuthHeader(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

export async function createBillplzBill(payload) {
  const apiKey = process.env.BILLPLZ_API_KEY?.trim();
  const collectionId = process.env.BILLPLZ_COLLECTION_ID?.trim();

  if (!apiKey || !collectionId) {
    return {
      isMock: true,
      billId: `mock-bill-${Date.now()}`,
      paymentUrl: "/thank-you?status=pending",
    };
  }

  const formData = new URLSearchParams({
    collection_id: collectionId,
    description: payload.description || "Wedding Gift Contribution",
    name: payload.name || "",
    amount: String(Math.round(payload.amount * 100)),
    callback_url: payload.callbackUrl || "",
    redirect_url: payload.redirectUrl || "",
    deliver: "false",
  });

  if (payload.email) formData.append("email", payload.email);
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

  if (!response.ok) {
    throw new Error(`Billplz error: ${rawBody.slice(0, 200)}`);
  }

  const data = JSON.parse(rawBody);

  if (!data?.id || !data?.url) {
    throw new Error(`Billplz did not return a bill URL. Response: ${rawBody.slice(0, 200)}`);
  }

  return { isMock: false, billId: data.id, paymentUrl: data.url };
}

export async function getBillplzBillTransactions(billId) {
  const apiKey = process.env.BILLPLZ_API_KEY?.trim();
  if (!apiKey) return [];

  const response = await fetch(`${billplzBaseUrl}/v3/bills/${billId}/transactions`, {
    method: "GET",
    headers: { Authorization: getBillplzAuthHeader(apiKey), Accept: "application/json" },
  });

  if (!response.ok) {
    const rawBody = await response.text();
    throw new Error(`Billplz transactions error: ${rawBody.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.transactions ?? [];
}

export function verifyBillplzCallbackSignature(fields) {
  const rawKey = process.env.BILLPLZ_X_SIGNATURE_KEY?.trim();
  const xSignatureKey = rawKey?.replace(/^["']|["']$/g, "");
  if (!xSignatureKey) return false;

  const providedSignature = fields.x_signature?.trim();
  if (!providedSignature) return false;

  const normalizedSignature = providedSignature.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedSignature)) return false;

  const source = Object.entries(fields)
    .filter(([key]) => key !== "x_signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value ?? "")
    .join("|");

  const computed = crypto.createHmac("sha256", xSignatureKey).update(source).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(normalizedSignature, "hex"));
  } catch {
    return false;
  }
}
