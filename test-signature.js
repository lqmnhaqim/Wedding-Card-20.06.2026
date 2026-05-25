import crypto from "node:crypto";

// 1. Set the secret key
const BILLPLZ_X_SIGNATURE_KEY =
  "5f3cc4849d32c9c5393386f2b1521d02e035df28a017defd78838887e9eb53573d7fbc3864123ad05916ab1aa56973b3e67661332e2498bcb416d03bb8b368f9";

// 2. Simulated callback body
const fields = {
  id: "dbaf88491c98ae42",
  paid: "true",
  state: "Paid",
  transaction_id: "test-tx-123",
  x_signature: "compute-the-hmac-sha256-of-the-source-string",
};

// 3. Compute the expected signature (EXACT same algorithm as billplz.js:94-106)
const source = Object.entries(fields)
  .filter(([key]) => key !== "x_signature")
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, value]) => value ?? "")
  .join("|");

const computed = crypto
  .createHmac("sha256", BILLPLZ_X_SIGNATURE_KEY)
  .update(source)
  .digest("hex")
  .toLowerCase();

// 4. Print results
console.log("Source string:", source);
console.log("Computed signature:", computed);

// Build the x_signature the way the real callback would
const providedXSignature = computed;

// Verification (mimic billplz.js timing-safe check)
let verified;
try {
  verified = crypto.timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(providedXSignature, "hex"),
  );
} catch {
  verified = false;
}

console.log("Provided x_signature:", providedXSignature);
console.log("Test passed:", verified);
