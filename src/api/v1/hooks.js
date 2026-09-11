const express = require("express");
const { Webhook } = require("standardwebhooks");
const router = express.Router();

function failure(response, status, message) {
  return response.status(status).json({ error: { http_code: status, message } });
}

router.post("/sms", async (request, response) => {
  const secret = process.env.SUPABASE_SMS_HOOK_SECRET;
  if (!secret) return failure(response, 503, "SMS hook is not configured");
  let event;
  try {
    if (!Buffer.isBuffer(request.body)) throw new Error("Expected raw JSON");
    event = new Webhook(secret.replace(/^v1,/, "")).verify(request.body.toString("utf8"), request.headers);
  } catch {
    return failure(response, 401, "Invalid webhook signature");
  }
  let phone = event?.user?.phone;
  const otp = event?.sms?.otp;
  if (typeof phone === "string") {
    if (/^09\d{9}$/.test(phone)) phone = `+63${phone.slice(1)}`;
    else if (/^639\d{9}$/.test(phone)) phone = `+${phone}`;
  }
  if (typeof phone !== "string" || !/^\+639\d{9}$/.test(phone) ||
    typeof otp !== "string" || !/^\d{4,10}$/.test(otp)) {
    return failure(response, 400, "Invalid SMS payload");
  }
  const headers = { "Content-Type": "application/json" };
  try {
    const gateway = await (request.app.locals.services.fetch || fetch)(
      "https://api.brevph.com/api/v1/cane/send", {
        method: "POST", headers,
        body: JSON.stringify({ recipient: phone,
          message: `Your COMSCA verification code is ${otp}. Do not share this code.` }),
        signal: AbortSignal.timeout(3000), redirect: "error",
      });
    if (!gateway.ok) return failure(response, 502, "SMS gateway rejected the message");
    return response.status(200).json({});
  } catch {
    return failure(response, 502, "SMS gateway unavailable");
  }
});

module.exports = router;
