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
  } catch (error) {
    console.error("Supabase OTP verification failed", {
      reason: response ? "invalid_json" : error.name === "TimeoutError" ? "timeout" : "network_error",
      ...(response && { status: response.status }),
    });
    throw Object.assign(new Error("Verification service unavailable"), { status: 502 });
  }
  if (!response.ok) {
    const code = result?.code || result?.error_code;
    const invalid = ["otp_expired", "otp_disabled", "validation_failed"].includes(code);
    const status = response.status === 429 ? 429 : invalid ? 400 : 502;
    if (status === 502) console.error("Supabase OTP verification failed", {
      reason: "provider_error", status: response.status,
      code: typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "unknown",
    });
    throw Object.assign(new Error(status === 429 ? "Too many verification attempts; try again later" :
      invalid ? "Invalid or expired verification code" : "Verification service unavailable"), { status });
  }
  if (!result?.user?.id || !/^[0-9a-f-]{36}$/i.test(result.user.id) ||
    !result.user.phone_confirmed_at ||
    `+${String(result.user.phone).replace(/^\+/, "")}` !== phone ||
    typeof result.access_token !== "string" || !result.access_token ||
    typeof result.refresh_token !== "string" || !result.refresh_token) {
    console.error("Supabase OTP verification failed", { reason: "invalid_session", status: response.status });
    throw Object.assign(new Error("Invalid verification response"), { status: 502 });
  }
  return result;
}

async function authRequest(path, body, accessToken) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw Object.assign(new Error("Supabase Auth is not configured"), { status: 503 });
  let response;
  let result;
  try {
    response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/${path}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json",
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }) },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if (response.status !== 204) result = await response.json();
  } catch {
    throw Object.assign(new Error("Authentication service unavailable"), { status: 502 });
  }
  if (!response.ok) {
    const code = result?.error_code || result?.code;
    let status = 502;
    let message = "Authentication service unavailable";
    if (response.status === 429) {
      status = 429; message = "Too many authentication attempts; try again later";
    } else if (code === "invalid_credentials") {
      status = 401; message = "Invalid phone number or password";
    } else if (code === "phone_not_confirmed") {
      status = 403; message = "Verify your phone number before signing in";
    } else if (["refresh_token_not_found", "refresh_token_already_used", "session_not_found",
      "session_expired", "bad_jwt", "no_authorization"].includes(code) ||
      (path.startsWith("logout") && [401, 403].includes(response.status))) {
      status = 401; message = "Invalid or expired session; sign in again";
    } else if (code === "user_banned") {
      status = 403; message = "Account access is unavailable";
    } else if (path === "otp" && ["user_not_found", "signup_disabled"].includes(code)) {
      // Keep login requests from exposing whether a phone number is registered.
      return {};
    } else if (["validation_failed", "bad_json", "captcha_failed"].includes(code)) {
      status = 400; message = "Authentication request could not be validated";
    }
    throw Object.assign(new Error(message), { status });
  }
  return result;
}

function validateSession(result, phone) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result?.user?.id || "") ||
    !result.user.phone_confirmed_at ||
    (phone && `+${String(result.user.phone).replace(/^\+/, "")}` !== phone) ||
    typeof result.access_token !== "string" || !result.access_token ||
    typeof result.refresh_token !== "string" || !result.refresh_token) {
    throw Object.assign(new Error("Invalid authentication response"), { status: 502 });
  }
  return result;
}

async function loginPassword({ phone, password }) {
  return validateSession(await authRequest("token?grant_type=password", { phone, password }), phone);
}

async function requestOtp({ phone }) {
  await authRequest("otp", { phone, channel: "sms", create_user: false });
}

async function refreshSession({ refresh_token }) {
  return validateSession(await authRequest("token?grant_type=refresh_token", { refresh_token }));
}

async function logout({ access_token }) {
  await authRequest("logout?scope=local", undefined, access_token);
}

module.exports = { signUp, verifyOtp, loginPassword, requestOtp, refreshSession, logout };
