const express = require("express");
const auth = require("../services/supabase-auth");
const authProfile = require("../services/auth-profile");
const router = express.Router();

function phoneNumber(value) {
  let phone = typeof value === "string" ? value.trim() : "";
  if (/^9\d{9}$/.test(phone)) phone = `+63${phone}`;
  else if (/^09\d{9}$/.test(phone)) phone = `+63${phone.slice(1)}`;
  else if (/^639\d{9}$/.test(phone)) phone = `+${phone}`;
  if (!/^\+639\d{9}$/.test(phone)) {
    throw Object.assign(new Error("Provide a valid phone number"), { status: 400 });
  }
  return phone;
}

function endpoint(fn) {
  return async (request, response, next) => {
    response.set("Cache-Control", "no-store");
    const service = (name, input) => (request.app.locals.services[name] || auth[name])(input);
    try {
      return response.json(await fn(request, service));
    } catch (error) {
      if (error.status) return response.status(error.status).json({ success: false, error: error.message });
      next(error);
    }
  };
}

router.post("/login/password", endpoint(async (request, service) => {
  const phone = phoneNumber(request.body?.phone);
  const password = request.body?.password;
  if (typeof password !== "string" || !password || Buffer.byteLength(password, "utf8") > 72) {
    throw Object.assign(new Error("A password (maximum 72 bytes) is required"), { status: 400 });
  }
  const verified = await service("loginPassword", { phone, password });
  return authProfile(request.app.locals.database, verified);
}));

router.post("/login/otp/request", endpoint(async (request, service) => {
  await service("requestOtp", { phone: phoneNumber(request.body?.phone) });
  return { success: true, message: "If an account exists for this phone number, a verification code has been sent" };
}));

router.post("/login/otp/verify", endpoint(async (request, service) => {
  const phone = phoneNumber(request.body?.phone);
  const otp = request.body?.otp;
  if (typeof otp !== "string" || !/^\d{4,10}$/.test(otp)) {
    throw Object.assign(new Error("Provide an OTP as a numeric string"), { status: 400 });
  }
  const verified = await service("verifyOtp", { phone, otp });
  return authProfile(request.app.locals.database, verified);
}));

router.post("/refresh", endpoint(async (request, service) => {
  const refresh_token = request.body?.refresh_token;
  if (typeof refresh_token !== "string" || !refresh_token.trim() || /\s/.test(refresh_token)) {
    throw Object.assign(new Error("A refresh_token is required"), { status: 400 });
  }
  const verified = await service("refreshSession", { refresh_token });
  return authProfile(request.app.locals.database, verified);
}));

router.post("/logout", endpoint(async (request, service) => {
  const match = /^Bearer ([^\s]+)$/i.exec(request.get("Authorization") || "");
  if (!match) throw Object.assign(new Error("A Bearer access token is required"), { status: 401 });
  await service("logout", { access_token: match[1] });
  return { success: true, message: "Logged out successfully" };
}));

module.exports = router;
