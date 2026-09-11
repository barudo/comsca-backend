async function signUp({ phone, password, metadata }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    const error = new Error("Supabase Auth is not configured");
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password, channel: "sms", data: metadata }),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error("Registration could not be completed");
    error.status = response.status === 429 ? 429 :
      ["weak_password", "validation_failed"].includes(result.code || result.error_code) ? 400 : 502;
    throw error;
  }
  return result.user || result;
}

async function verifyOtp({ phone, otp }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw Object.assign(new Error("Supabase Auth is not configured"), { status: 503 });
  let response;
  let result;
  try {
    response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ phone, token: otp, type: "sms" }),
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
    result = await response.json();
  } catch {
    throw Object.assign(new Error("Verification service unavailable"), { status: 502 });
  }
  if (!response.ok) {
    const invalid = ["otp_expired", "otp_disabled", "validation_failed"].includes(result.code || result.error_code);
    const status = response.status === 429 ? 429 : invalid ? 400 : 502;
    throw Object.assign(new Error(status === 429 ? "Too many verification attempts; try again later" :
      invalid ? "Invalid or expired verification code" : "Verification service unavailable"), { status });
  }
  if (!result?.user?.id || !/^[0-9a-f-]{36}$/i.test(result.user.id) ||
    !result.user.phone_confirmed_at ||
    `+${String(result.user.phone).replace(/^\+/, "")}` !== phone ||
    typeof result.access_token !== "string" || !result.access_token ||
    typeof result.refresh_token !== "string" || !result.refresh_token) {
    throw Object.assign(new Error("Invalid verification response"), { status: 502 });
  }
  return result;
}

module.exports = { signUp, verifyOtp };
