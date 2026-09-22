const express = require("express");
const authenticate = require("../middleware/authenticate");
const router = express.Router();

const cycleColumns = ["id", "group_id", "interest_rate", "interest_period", "interest_method",
  "cost_per_share", "status", "created_at", "updated_at"];

function cycleInput(body, current) {
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("A cycle object is required");
  const allowed = ["interest_rate", "interest_period", "interest_method", "cost_per_share", "status"];
  if (Object.keys(body).some(key => !allowed.includes(key))) fail("Unsupported cycle field");
  if (current) {
    if (!Object.keys(body).length) fail("At least one cycle field is required");
    if (current.status !== "draft" && Object.keys(body).some(key => key !== "status")) {
      fail("Financial settings can only be updated on a draft cycle", 409);
    }
    body = { ...Object.fromEntries(allowed.map(key => [key, current[key]])), ...body };
  }

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
    status: body.status === undefined ? "draft" : body.status,
  };
  if (!["draft", "active", "distributing", "closed"].includes(values.status)) {
    fail("status must be draft, active, distributing, or closed");
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
      if (values.status !== "draft") {
        throw Object.assign(new Error("New cycles must start in draft status"), { status: 400 });
      }
      const [created] = await trx("cycles").insert({ ...values, group_id: request.group.id })
        .returning(cycleColumns);
      return created;
    });
    return response.status(201).json({ success: true, cycle });
  } catch (error) {
    if (error.code === "23505" && error.constraint === "cycles_one_current_per_group") {
      return response.status(409).json({ success: false, error: "This group already has a current cycle" });
    }
    if ([400, 403].includes(error.status)) {
      return response.status(error.status).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

router.patch("/:id", authenticate, async (request, response, next) => {
  try {
    const cycle = await request.app.locals.database.transaction(async trx => {
      const actor = await trx("users").where({
        auth_user_id: request.authUser.id, group_id: request.group.id,
      }).forUpdate().first("id", "role");
      if (!actor || !["OWNER", "ADMIN"].includes(actor.role)) {
        throw Object.assign(new Error("Only an OWNER or ADMIN of this group can update cycles"), { status: 403 });
      }
      const id = request.params.id;
      if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
        throw Object.assign(new Error("A valid cycle ID is required"), { status: 400 });
      }
      // Check the locked, current row, not a status supplied by the client.
      const current = await trx("cycles").where({ id, group_id: request.group.id })
        .forUpdate().first(...cycleColumns);
      if (!current) {
        throw Object.assign(new Error("Cycle not found in this group"), { status: 404 });
      }
      if (current.status === "closed") {
        throw Object.assign(new Error("Closed cycles are read-only"), { status: 409 });
      }
      const values = cycleInput(request.body, current);
      const hasFinancialFields = Object.keys(request.body).some(key => key !== "status");
      const nextStatus = { draft: "active", active: "distributing", distributing: "closed" }[current.status];
      if (values.status !== current.status && values.status !== nextStatus) {
        throw Object.assign(new Error("Invalid cycle status transition"), { status: 409 });
      }
      if (!hasFinancialFields && values.status === current.status) return current;
      const changes = Object.fromEntries(Object.keys(request.body).map(key => [key, values[key]]));
      const [updated] = await trx("cycles").where({ id, group_id: request.group.id })
        .update({ ...changes, updated_at: trx.raw("clock_timestamp()") }).returning(cycleColumns);
      return updated;
    });
    return response.json({ success: true, cycle });
  } catch (error) {
    if (error.code === "23505" && error.constraint === "cycles_one_current_per_group") {
      return response.status(409).json({ success: false, error: "This group already has a current cycle" });
    }
    if ([400, 403, 404, 409].includes(error.status)) {
      return response.status(error.status).json({ success: false, error: error.message });
    }
    return next(error);
  }
});

module.exports = router;
