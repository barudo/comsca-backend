const express = require("express");
const authenticate = require("../middleware/authenticate");
const router = express.Router();

function cycleInput(body) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("A cycle object is required");
  const allowed = ["interest_rate", "interest_period", "interest_method", "cost_per_share", "status"];
  if (Object.keys(body).some(key => !allowed.includes(key))) fail("Unsupported cycle field");

  // Keep decimals as strings so PostgreSQL receives the supplied precision.
  const decimal = (field, precision, scale, positive) => {
    const value = body[field];
    if (value === undefined || value === null) return null;
    if (!["number", "string"].includes(typeof value)) fail(`${field} must be a decimal number`);
    if (typeof value === "number" && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      fail(`${field} must be sent as a decimal string for amounts above the safe JSON number range`);
    }
    const text = String(value).trim();
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) fail(`${field} must be a nonnegative fixed-point decimal`);
    const integer = match[1].replace(/^0+/, "") || "0";
    const fraction = match[2] || "";
    if (integer.length > precision - scale || fraction.length > scale) {
      fail(`${field} allows at most ${precision - scale} integer digits and ${scale} decimal places`);
    }
    if (positive && !/[1-9]/.test(integer + fraction)) fail(`${field} must be greater than zero`);
    return fraction ? `${integer}.${fraction}` : integer;
  };
  const values = {
    interest_rate: decimal("interest_rate", 9, 6, false),
    interest_period: body.interest_period ?? null,
    interest_method: body.interest_method ?? null,
    cost_per_share: decimal("cost_per_share", 18, 2, true),
    status: body.status === undefined ? "inactive" : body.status,
  };
  if (!["active", "inactive", "distributing"].includes(values.status)) {
    fail("status must be active, inactive, or distributing");
  }
  if (values.interest_period !== null && !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(values.interest_period)) {
    fail("interest_period must be DAILY, WEEKLY, MONTHLY, or YEARLY");
  }
  if (values.interest_method !== null && !["SIMPLE", "COMPOUND"].includes(values.interest_method)) {
    fail("interest_method must be SIMPLE or COMPOUND");
  }
  const interest = [values.interest_rate, values.interest_period, values.interest_method];
  if (interest.some(value => value !== null) && interest.some(value => value === null)) {
    fail("interest_rate, interest_period, and interest_method must be provided together");
  }
  return values;
}

router.post("/", authenticate, async (request, response, next) => {
  try {
    const cycle = await request.app.locals.database.transaction(async trx => {
      // Serialize against role revocation or reassignment, as for member creation.
      const actor = await trx("users").where({
        auth_user_id: request.authUser.id, group_id: request.group.id,
      }).forUpdate().first("id", "role");
      if (!actor || !["OWNER", "ADMIN"].includes(actor.role)) {
        throw Object.assign(new Error("Only an OWNER or ADMIN of this group can create cycles"), { status: 403 });
      }
      const values = cycleInput(request.body);
      const [created] = await trx("cycles").insert({ ...values, group_id: request.group.id })
        .returning(["id", "group_id", "interest_rate", "interest_period", "interest_method",
          "cost_per_share", "status", "created_at", "updated_at"]);
      return created;
    });
    return response.status(201).json({ success: true, cycle });
  } catch (error) {
    if (error.code === "23505" && error.constraint === "cycles_one_active_per_group") {
      return response.status(409).json({ success: false, error: "This group already has an active cycle" });
    }
    if ([400, 403].includes(error.status)) {
      return response.status(error.status).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

module.exports = router;
