const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const state = { role: "OWNER", group: 1, inserts: [], insertError: null, authError: null };
  state.cycle = { id: "20", group_id: 1, interest_rate: "2.500000", interest_period: "MONTHLY",
    interest_method: "COMPOUND", cost_per_share: "100.00", status: "draft",
    created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" };
  state.updates = [];
  state.cycleReads = 0;
  state.updateError = null;
  const authId = "11111111-1111-4111-8111-111111111111";
  Object.defineProperty(db, "transaction", { value: async callback => callback(db) });
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    if (query.sql.includes('from "groups"')) {
      return query.bindings[0] === "alpha" ? { id: 1, slug: "alpha" } :
        query.bindings[0] === "beta" ? { id: 2, slug: "beta" } : undefined;
    }
    if (query.sql.includes('from "users"')) {
      assert.match(query.sql, /for update$/);
      assert.deepEqual(query.bindings, [authId, query.bindings[1], 1]);
      return query.bindings[1] === state.group ? { id: 10, role: state.role } : undefined;
    }
    if (query.sql.includes('from "cycles"')) {
      state.cycleReads++;
      assert.match(query.sql, /where "id" = \? and "group_id" = \? limit \? for update$/);
      return query.bindings[0] === state.cycle?.id && query.bindings[1] === state.cycle.group_id ? { ...state.cycle } : undefined;
    }
    if (query.sql.startsWith('update "cycles"')) {
      assert.match(query.sql, /where "id" = \? and "group_id" = \? returning/);
      assert.deepEqual(query.bindings.slice(-2), [state.cycle.id, state.cycle.group_id]);
      assert.equal(builder._single.update.updated_at.toSQL().sql, "clock_timestamp()");
      if (state.updateError) throw state.updateError;
      const { updated_at, ...values } = builder._single.update;
      state.updates.push(values);
      state.cycle = { ...state.cycle, ...values, updated_at: "2026-09-21T00:00:00.000Z" };
      return [{ ...state.cycle }];
    }
    assert.match(query.sql, /^insert into "cycles"/);
    if (state.insertError) throw state.insertError;
    const values = builder._single.insert;
    state.inserts.push(values);
    assert.deepEqual(query.returning, ["id", "group_id", "interest_rate", "interest_period", "interest_method",
      "cost_per_share", "status", "created_at", "updated_at",
      "name", "description", "absence_penalty", "required_monthly_contribution"]);
    return [{ id: 20, ...values, created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" }];
  } });
  const handler = serverless(createApp(db, { getUser: async () => {
    if (state.authError) throw state.authError;
    return { id: authId, user_metadata: { role: "OWNER", group_id: 2 } };
  } }));
  const send = async (method, body = {}, options = {}) => {
    const response = await handler({ version: "2.0", rawPath: options.path || (method === "PATCH" ? "/api/v1/cycles/20" : "/api/v1/cycles"),
      rawQueryString: "group_id=2", headers: { "content-type": "application/json",
        authorization: "Bearer verified-token", "x-group-slug": "alpha", ...options.headers },
      requestContext: { http: { method, sourceIp: "127.0.0.1" } },
      body: options.rawBody ?? JSON.stringify(body), isBase64Encoded: false }, {});
    const responseBody = response.headers["content-type"]?.includes("application/json")
      ? JSON.parse(response.body) : response.body;
    return { status: response.statusCode, body: responseBody, headers: response.headers };
  };
  return { state, post: (body, options) => send("POST", body, options),
    patch: (body, options) => send("PATCH", body, options) };
}

const emptyCreationFields = { name: null, description: null, absence_penalty: null, required_monthly_contribution: null };

const terms = { interest_rate: "2.500000", interest_period: "MONTHLY", interest_method: "COMPOUND", cost_per_share: "100.00" };

test("cycle creation permits group OWNER/ADMIN on the versioned path and returns saved fields", async t => {
  const { state, post } = fixture(t);
  for (const role of ["OWNER", "ADMIN"]) {
    state.role = role;
    for (const path of ["/api/v1/cycles"]) {
      const result = await post({ ...terms, status: "draft" }, { path });
      assert.equal(result.status, 201);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(result.body, { success: true, cycle: { id: 20, ...emptyCreationFields, ...terms, status: "draft", group_id: 1,
        created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" } });
    }
  }
  state.group = 2;
  assert.equal((await post({}, { headers: { "x-group-slug": "beta" } })).body.cycle.group_id, 2);
});

test("cycles support nullable financial settings, allowed enums, statuses and exact decimal limits", async t => {
  const { post } = fixture(t);
  assert.deepEqual((await post()).body.cycle, { id: 20, ...emptyCreationFields, group_id: 1, interest_rate: null,
    interest_period: null, interest_method: null, cost_per_share: null, status: "draft",
    created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" });
  assert.equal((await post({ interest_rate: null, interest_period: null, interest_method: null, cost_per_share: null })).status, 201);
  for (const interest_period of ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]) {
    for (const interest_method of ["SIMPLE", "COMPOUND"]) {
      assert.equal((await post({ ...terms, interest_rate: 0, interest_period, interest_method })).status, 201);
    }
  }
  assert.equal((await post({ status: "draft" })).status, 201);
  for (const status of ["active", "distributing", "closed", "inactive"]) {
    assert.equal((await post({ status })).status, 400);
  }
  for (const interest_rate of ["999.999999", "0.000001", 2.5]) {
    assert.equal((await post({ ...terms, interest_rate })).status, 201);
  }
  for (const cost_per_share of ["9999999999999999.99", "0.01", 100]) {
    const result = await post({ cost_per_share });
    assert.equal(result.status, 201);
    assert.equal(result.body.cycle.cost_per_share, String(cost_per_share));
  }
});

test("cycles reject unauthenticated, cross-group and non-manager requests without inserts", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post({}, { headers: { authorization: "" } })).status, 401);
  assert.equal((await post({}, { headers: { "x-group-slug": "" } })).status, 400);
  assert.equal((await post({}, { headers: { "x-group-slug": "unknown" } })).status, 404);
  for (const path of ["/api/v1/cycles"]) {
    assert.equal((await post({}, { path, headers: { "x-group-slug": "beta" } })).status, 403);
    for (const role of ["MEMBER", "TREASURER", "AUDITOR", "admin", null]) {
      state.role = role;
      assert.equal((await post({}, { path })).status, 403);
    }
  }
  state.authError = Object.assign(new Error("Invalid token"), { status: 401 });
  assert.equal((await post()).status, 401);
  assert.equal(state.inserts.length, 0);
});

test("cycle input enforces database constraints and rejects protected or unknown fields", async t => {
  const { state, post } = fixture(t);
  for (const body of [null, [], "cycle", { group_id: 2 }, { id: 20 }, { created_at: "2026-09-20" },
    { updated_at: "2026-09-20" }, { unknown_field: "Cycle" }, { status: null }, { status: "ACTIVE" },
    { status: "ended" }, { status: [] }, { interest_rate: 2 }, { interest_period: "MONTHLY" },
    { interest_method: "SIMPLE" }, { ...terms, interest_method: null }, { ...terms, interest_rate: null },
    { ...terms, interest_period: null }, { ...terms, interest_period: "monthly" },
    { ...terms, interest_method: "FLAT" }, { ...terms, interest_rate: -1 },
    { ...terms, interest_rate: "1000" }, { ...terms, interest_rate: "0.0000001" },
    { ...terms, interest_rate: true }, { ...terms, interest_rate: "NaN" },
    { ...terms, interest_rate: "Infinity" }, { ...terms, interest_rate: "1e2" },
    { ...terms, interest_rate: "" }, { cost_per_share: 0 }, { cost_per_share: -1 },
    { cost_per_share: "0.001" }, { cost_per_share: "10000000000000000" },
    { cost_per_share: {} }, { cost_per_share: "NaN" }, { cost_per_share: "Infinity" }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post({}, { rawBody: "{" })).status, 400);
  assert.equal((await post({}, { rawBody: '{"cost_per_share":9007199254740993}' })).status, 400);
  assert.equal(state.inserts.length, 0);
});

test("cycle creation reports current-cycle conflicts without exposing internal failures", async t => {
  const { state, post } = fixture(t);
  state.insertError = Object.assign(new Error("Private constraint details"), { code: "23505", constraint: "cycles_one_current_per_group" });
  const conflict = await post({ status: "draft" });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, { success: false, error: "This group already has a current cycle" });
  for (const error of [new Error("Private database details"), Object.assign(new Error("Other unique constraint"), { code: "23505", constraint: "cycles_pkey" })]) {
    state.insertError = error;
    const result = await post();
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { success: false, error: "Internal server error" });
  }
});

test("OWNER/ADMIN can partially update draft cycles on both paths without resetting omitted fields", async t => {
  const { state, patch } = fixture(t);
  for (const role of ["OWNER", "ADMIN"]) {
    state.role = role;
    for (const path of ["/cycles/20", "/api/v1/cycles/20"]) {
      const result = await patch({ interest_rate: "3.500000" }, { path });
      assert.equal(result.status, 200);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.equal(result.body.success, true);
      assert.deepEqual(result.body.cycle, { ...state.cycle, interest_rate: "3.500000" });
      assert.equal(result.body.cycle.interest_period, "MONTHLY");
      assert.equal(result.body.cycle.cost_per_share, "100.00");
      assert.equal(result.body.cycle.created_at, "2026-09-20T00:00:00.000Z");
      assert.equal(result.body.cycle.updated_at, "2026-09-21T00:00:00.000Z");
      assert.deepEqual(state.updates.at(-1), { interest_rate: "3.500000" });
    }
  }
  assert.equal((await patch({ interest_rate: null, interest_period: null, interest_method: null, cost_per_share: null })).status, 200);
  assert.equal(state.cycle.interest_rate, null);
  assert.equal((await patch({ ...terms, status: "active" })).status, 200);
  assert.equal(state.cycle.status, "active");
});

test("cycle updates enforce every transition and allow status-only retries without a write", async t => {
  const { state, patch } = fixture(t);
  const allowed = { draft: "active", active: "distributing", distributing: "closed" };
  for (const from of ["draft", "active", "distributing", "closed"]) {
    for (const to of ["draft", "active", "distributing", "closed"]) {
      state.cycle.status = from;
      const before = { ...state.cycle };
      const count = state.updates.length;
      const result = await patch({ status: to });
      assert.equal(result.status, from !== "closed" && (from === to || allowed[from] === to) ? 200 : 409, `${from} -> ${to}`);
      if (allowed[from] === to) {
        assert.equal(state.cycle.status, to);
        assert.deepEqual(state.updates.at(-1), { status: to });
      } else {
        assert.equal(state.updates.length, count);
        assert.deepEqual(state.cycle, before);
      }
    }
  }
});

test("financial fields cannot be supplied on active, distributing, or closed cycles, even during transition", async t => {
  const { state, patch } = fixture(t);
  for (const status of ["active", "distributing", "closed"]) {
    state.cycle.status = status;
    for (const body of [{ interest_rate: null }, { cost_per_share: -1 }, { interest_period: "invalid" }]) {
      assert.equal((await patch(body)).status, 409);
    }
    for (const field of Object.keys(terms)) {
      for (const body of [{ [field]: terms[field] }, { [field]: terms[field], status: "distributing" },
        { [field]: terms[field], status: "draft" }]) {
        assert.equal((await patch(body)).status, 409);
      }
    }
  }
  assert.equal(state.updates.length, 0);
});

test("cycle updates reject unauthorized identities, missing groups and other-group cycles", async t => {
  const { state, patch } = fixture(t);
  assert.equal((await patch({ status: "active" }, { headers: { authorization: "" } })).status, 401);
  state.authError = Object.assign(new Error("Invalid token"), { status: 401 });
  assert.equal((await patch({ status: "active" })).status, 401);
  state.authError = null;
  assert.equal((await patch({ status: "active" }, { headers: { "x-group-slug": "" } })).status, 400);
  assert.equal((await patch({ status: "active" }, { headers: { "x-group-slug": "unknown" } })).status, 404);
  assert.equal((await patch({ status: "active" }, { headers: { "x-group-slug": "beta" } })).status, 403);
  for (const role of ["MEMBER", "TREASURER", "AUDITOR", "ADMINISTRATOR", null]) {
    state.role = role;
    assert.equal((await patch({ status: "active" })).status, 403);
  }
  assert.equal(state.cycleReads, 0);
  state.role = "OWNER";
  state.cycle.group_id = 2;
  assert.equal((await patch({ status: "active" })).status, 404);
  state.cycle = null;
  assert.equal((await patch({ status: "active" })).status, 404);
  assert.equal(state.updates.length, 0);
});

test("cycle updates validate IDs, request shape, protected fields and merged financial settings", async t => {
  const { state, patch } = fixture(t);
  for (const id of ["0", "-1", "1.2", "1e2", "abc", "01", "9223372036854775808", "9999999999999999999999"]) {
    assert.equal((await patch({ status: "active" }, { path: `/cycles/${id}` })).status, 400);
  }
  assert.equal(state.cycleReads, 0);
  for (const body of [{}, null, [], { group_id: 2 }, { id: "21" }, { created_at: "today" },
    { updated_at: "today" }, { role: "OWNER" }, { name: "x" }, { status: "ACTIVE" },
    { status: "DISTRBUTING" }, { status: "inactive" }, { status: null }, { status: "ended" },
    { interest_rate: null }, { interest_method: null }, { interest_period: null },
    { interest_rate: -1 }, { interest_rate: "1000" }, { interest_rate: "0.0000001" },
    { interest_period: "monthly" }, { interest_method: "FLAT" }, { cost_per_share: 0 },
    { cost_per_share: "0.001" }, { cost_per_share: "NaN" }]) {
    assert.equal((await patch(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await patch({}, { rawBody: "{" })).status, 400);
  assert.equal((await patch({}, { rawBody: '{"cost_per_share":9007199254740993}' })).status, 400);
  assert.equal(state.updates.length, 0);
  state.cycle.interest_rate = state.cycle.interest_period = state.cycle.interest_method = null;
  assert.equal((await patch({ interest_rate: "1" })).status, 400);
  assert.equal((await patch({ interest_rate: "1", interest_period: "DAILY", interest_method: "SIMPLE" })).status, 200);
  // Preserve bigint IDs as strings, including beyond JavaScript's safe integers.
  state.cycle.id = "9223372036854775807";
  assert.equal((await patch({ cost_per_share: "0.01" }, { path: `/cycles/${state.cycle.id}` })).status, 200);
});

test("cycle updates report current-cycle conflicts and hide unexpected database errors", async t => {
  const { state, patch } = fixture(t);
  const before = { ...state.cycle };
  state.updateError = Object.assign(new Error("Private details"), { code: "23505", constraint: "cycles_one_current_per_group" });
  const result = await patch({ status: "active", cost_per_share: "200" });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { success: false, error: "This group already has a current cycle" });
  assert.deepEqual(state.cycle, before);
  state.updateError = new Error("Private database details");
  assert.deepEqual((await patch({ cost_per_share: "200" })).body, { success: false, error: "Internal server error" });
});


test("creation saves and returns descriptive and currency fields on the versioned endpoint", async t => {
  const { state, post } = fixture(t);
  const fields = { name: "Cycle 2026", description: "Monthly savings", absence_penalty: "0.00",
    required_monthly_contribution: "9999999999999999.99" };
  for (const path of ["/api/v1/cycles"]) {
    const result = await post(fields, { path });
    assert.equal(result.status, 201);
    for (const [key, value] of Object.entries(fields)) {
      assert.equal(result.body.cycle[key], value);
      assert.equal(state.inserts.at(-1)[key], value);
    }
  }
  assert.equal((await post(emptyCreationFields)).status, 201);
  assert.equal((await post({ name: "😀".repeat(255), description: "x".repeat(1000) })).status, 201);
  for (const field of ["absence_penalty", "required_monthly_contribution"]) {
    for (const value of [0, 10.5, "0.01", null]) {
      const result = await post({ [field]: value });
      assert.equal(result.status, 201);
      assert.equal(result.body.cycle[field], value === null ? null : String(value));
    }
  }
});

test("creation rejects invalid descriptive and currency fields before inserting", async t => {
  const { state, post } = fixture(t);
  for (const field of ["name", "description"]) {
    for (const value of [1, true, [], {}, "bad\u0000text"]) {
      assert.equal((await post({ [field]: value })).status, 400);
    }
  }
  assert.equal((await post({ name: "😀".repeat(256) })).status, 400);
  for (const field of ["absence_penalty", "required_monthly_contribution"]) {
    for (const value of [-1, "-0.01", "0.001", "10000000000000000", "NaN", "Infinity", "1e2", "", true, {}, [], 9007199254740992]) {
      assert.equal((await post({ [field]: value })).status, 400, `${field}: ${JSON.stringify(value)}`);
    }
  }
  assert.equal(state.inserts.length, 0);
});


test("the removed POST /cycles alias does not create a cycle", async t => {
  const { state, post } = fixture(t);
  assert.equal((await post(terms, { path: "/cycles" })).status, 404);
  assert.equal(state.inserts.length, 0);
});
