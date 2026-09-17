async function createMemberAccount({ phone, password, user_id, group_id, actor_id }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Object.assign(new Error("Account provisioning is not configured"), { status: 503 });
  let response;
  let result;
  try {
    response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/admin/users`, {
      method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone, password, phone_confirm: true,
        app_metadata: { comsca_member: { user_id: String(user_id), group_id: String(group_id), actor_id: String(actor_id) } } }),
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
    result = await response.json();
  } catch {
    throw Object.assign(new Error("Account provisioning service unavailable"), { status: 502 });
  }
  if (!response.ok) {
    const code = result?.code || result?.error_code;
    if (["phone_exists", "user_already_exists", "email_exists"].includes(code) || response.status === 409) {
      throw Object.assign(new Error("A login account already exists for this phone number"), { status: 409 });
    }
    if (["weak_password", "validation_failed"].includes(code)) {
      throw Object.assign(new Error("Account details do not meet authentication requirements"), { status: 400 });
    }
    throw Object.assign(new Error("Account provisioning service unavailable"), { status: response.status === 429 ? 429 : 502 });
  }
  const user = result?.user || result;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user?.id || "") ||
    !user.phone_confirmed_at || `+${String(user.phone).replace(/^\+/, "")}` !== phone) {
    throw Object.assign(new Error("Invalid account provisioning response"), { status: 502 });
  }
  return user;
}

module.exports = { createMemberAccount };
