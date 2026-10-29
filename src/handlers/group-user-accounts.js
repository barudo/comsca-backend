const { randomBytes } = require("node:crypto");
const { createMemberAccount } = require("../services/member-account");

class GroupUserAccountsHandler {
  async create(request, response, next) {
    try {
      const db = request.app.locals.database;
      const actor = await db("users").where({ auth_user_id: request.authUser.id, group_id: request.group.id }).first("id", "role");
      if (!actor || !["OWNER", "ADMIN"].includes(actor.role)) {
        return response.status(403).json({ success: false, error: "Only an OWNER or ADMIN of this group can provision accounts" });
      }
      const id = request.params.id;
      const body = request.body;
      if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n ||
        !body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => key !== "password") ||
        (body.password !== undefined && (typeof body.password !== "string" ||
          (body.password.trim() !== "" && (body.password.length < 8 || Buffer.byteLength(body.password, "utf8") > 72))))) {
        return response.status(400).json({ success: false, error: "A valid user ID and object body are required; provide a blank password to generate one, or a password of at least 8 characters and maximum 72 UTF-8 bytes" });
      }
      const target = await db("users").where({ id, group_id: request.group.id }).first("id", "phone", "auth_user_id");
      if (!target) return response.status(404).json({ success: false, error: "User not found in this group" });
      if (target.auth_user_id) return response.status(409).json({ success: false, error: "User already has login access" });
      if (!/^\+639[0-9]{9}$/.test(target.phone || "")) {
        return response.status(400).json({ success: false, error: "User must have a valid saved phone number" });
      }
      // Fail before contacting Auth if the atomic linking migration is missing.
      const migration = await db("knex_migrations").where({ name: "009_link_member_auth_accounts.js" }).first("id");
      if (!migration) return response.status(503).json({ success: false, error: "Account provisioning migration is required" });
      const generated = body.password === undefined || body.password.trim() === "";
      const password = generated ? `${randomBytes(24).toString("base64url")}Aa1!` : body.password;
      // Do not hold locks here: Auth's deferred trigger locks and links the member.
      const account = await (request.app.locals.services.createMemberAccount || createMemberAccount)({
        phone: target.phone, password, user_id: target.id, group_id: request.group.id, actor_id: actor.id,
      });
      const linked = await db("users").where({ id, group_id: request.group.id, auth_user_id: account.id }).first("id", "group_id", "phone", "role");
      if (!linked) throw Object.assign(new Error("Account provisioning could not be confirmed"), { status: 502 });
      return response.status(201).json({ success: true, ...(generated ? { generated_password: password } : {}), user: { ...linked, has_login: true, phone_verified: true } });
    } catch (error) {
      if ([400, 409, 429, 502, 503].includes(error.status)) {
        return response.status(error.status).json({ success: false, error: error.message });
      }
      return next(error);
    }
  }
}

module.exports = GroupUserAccountsHandler;
