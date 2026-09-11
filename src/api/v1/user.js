const express = require("express");
const { signUp, verifyOtp } = require("../../services/supabase-auth");
const router = express.Router();

router.post("/register", async (request, response, next) => {
  const body = request.body || {};
  const { firstname, lastname, groupName, password } = body;
  if ([firstname, lastname, groupName].some((v) => typeof v !== "string" || !v.trim() || v.trim().length > 255) ||
    typeof body.slug !== "string" || typeof body.phone !== "string" ||
    typeof password !== "string" || password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
    return response.status(400).json({ success: false, error: "Provide firstname, lastname, phone, groupName, slug and a password of at least 8 characters (maximum 72 bytes)" });
  }
  const slug = body.slug.trim().toLowerCase();
  let phone = body.phone.trim();
  if (/^09\d{9}$/.test(phone)) phone = `+63${phone.slice(1)}`;
  else if (/^639\d{9}$/.test(phone)) phone = `+${phone}`;
  if (!/^\+639\d{9}$/.test(phone) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) ||
    ["www", "api", "app", "admin", "auth"].includes(slug)) {
    return response.status(400).json({ success: false, error: "Provide a valid phone number and group subdomain slug" });
  }
  response.set("Cache-Control", "no-store");
  const db = request.app.locals.database;
  try {
    if (await db("groups").where({ slug }).first("id")) {
      return response.status(409).json({ success: false, error: "Group slug is already in use" });
    }
    const authUser = await (request.app.locals.services.signUp || signUp)({
      phone, password,
      metadata: { comsca_registration: {
        firstname: firstname.trim(), lastname: lastname.trim(), groupName: groupName.trim(), slug,
      } },
    });
    // The auth.users trigger inserts both application records atomically.
    // Do not attach an existing Auth identity to a newly submitted group.
    if (!authUser?.id || !/^[0-9a-f-]{36}$/i.test(authUser.id)) {
      return response.status(502).json({ success: false, error: "Registration could not be completed" });
    }
    const user = await db("users").where({ auth_user_id: authUser.id }).first("id", "group_id");
    const group = user && await db("groups").where({ id: user.group_id, slug }).first("id");
    if (!group) {
      return response.status(409).json({ success: false, error: "Registration could not be completed; sign in or recover your existing account" });
    }
    // No session or personal profile is returned before phone ownership is verified.
    return response.status(201).json({ success: true, verification_required: !authUser.phone_confirmed_at,
      message: authUser.phone_confirmed_at ? "Registration completed" : "Verify the code sent to your phone to complete registration" });
  } catch (error) {
    if (error.status) return response.status(error.status).json({ success: false, error: error.message });
    if (error.name === "TimeoutError" || error.name === "TypeError") {
      return response.status(502).json({ success: false, error: "Registration service unavailable" });
    }
    next(error);
  }
});

router.post("/verify", async (request, response, next) => {
  response.set("Cache-Control", "no-store");
  let { phone, otp } = request.body || {};
  if (typeof phone === "string") {
    phone = phone.trim();
    if (/^09\d{9}$/.test(phone)) phone = `+63${phone.slice(1)}`;
    else if (/^639\d{9}$/.test(phone)) phone = `+${phone}`;
  }
  if (typeof phone !== "string" || !/^\+639\d{9}$/.test(phone) ||
    typeof otp !== "string" || !/^\d{4,10}$/.test(otp)) {
    return response.status(400).json({ success: false, error: "Provide a valid phone number and OTP as a numeric string" });
  }
  try {
    const verified = await (request.app.locals.services.verifyOtp || verifyOtp)({ phone, otp });
    // Resolve membership using the verified identity, never a caller-supplied ID or slug.
    const db = request.app.locals.database;
    const user = await db("users").where({ auth_user_id: verified.user.id })
      .first("id", "auth_user_id", "group_id", "first_name", "family_name", "phone");
    if (!user) return response.status(409).json({ success: false, error: "Verified account has no linked application profile" });
    const group = await db("groups").where({ id: user.group_id }).first("id", "name", "slug");
    if (!group) return response.status(409).json({ success: false, error: "Verified account has no linked group" });
    return response.json({ success: true, user, group, session: {
      access_token: verified.access_token,
      refresh_token: verified.refresh_token,
      token_type: verified.token_type,
      expires_in: verified.expires_in,
      expires_at: verified.expires_at,
    } });
  } catch (error) {
    if (error.status) return response.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
});

module.exports = router;
