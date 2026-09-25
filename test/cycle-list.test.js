const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const serverless = require("serverless-http");
const { createApp } = require("../src/app");

function fixture(t) {
  const db = knex({ client: "pg" });
  t.after(() => db.destroy());
  const authId = "11111111-1111-4111-8111-111111111111";
  const cycle = { id: "20", group_id: "1", status: "draft", interest_rate: "2.500000",
    interest_period: "MONTHLY", interest_method: "COMPOUND", cost_per_share: "9999999999999999.99",
    created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" };
  const state = { role: "OWNER", cycles: [{ ...cycle, id: "21", status: "closed" }, cycle],
    authError: null, dbError: null, queries: [] };
  Object.defineProperty(db, "transaction", { value: async callback => callback(db) });
  db.client.runner = builder => ({ run: async () => {
    const query = builder.toSQL();
    state.queries.push(query);
    if (query.sql.includes('from "groups"')) {
      return query.bindings[0] === "alpha" ? { id: "1", slug: "alpha" } :
        query.bindings[0] === "beta" ? { id: "2", slug: "beta" } : undefined;
    }
    if (query.sql.includes('from "users"')) {
      assert.deepEqual(query.bindings, [authId, query.bindings[1], 1]);
      return query.bindings[1] === "1" ? { id: "10", role: state.role } : undefined;
    }
    if (query.sql === "SET LOCAL ROLE comsca_group_reader") return {};
    if (query.sql.includes("set_config")) {
      assert.deepEqual(query.bindings, ["1"]);
      return {};
    }
    if (state.dbError) throw state.dbError;
    assert.match(query.sql, /from "cycles" where "group_id" = \? and "status" in \(\?, \?, \?\) order by "created_at" desc, "id" desc limit \?$/);
    assert.deepEqual(query.bindings, ["1", "draft", "distributing", "active", 1]);
    for (const column of Object.keys(cycle)) assert.ok(query.sql.includes(`"${column}"`), column);
    assert.doesNotMatch(query.sql, /select \*/);
    return state.cycles.filter(cycle => cycle.group_id === "1" && ["draft", "distributing", "active"].includes(cycle.status))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
      .slice(0, 1);
  } });
  const handler = serverless(createApp(db, { getUser: async () => {
    if (state.authError) throw state.authError;
    return { id: authId, user_metadata: { role: "OWNER", group_id: "2" } };
  } }));
  const get = async (path = "/api/v1/cycles", headers = {}) => {
    const result = await handler({ version: "2.0", rawPath: path,
      rawQueryString: "group_id=2&status=active&current_cycle_id=999",
      headers: { authorization: "Bearer verified-token", "x-group-slug": "alpha", ...headers },
      requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } } }, {});
    return { status: result.statusCode, body: JSON.parse(result.body), headers: result.headers };
  };
  return { state, get };
}

test("GET cycles returns only the latest qualifying cycle for OWNER/ADMIN", async t => {
  const { state, get } = fixture(t);
  for (const role of ["OWNER", "ADMIN"]) {
    state.role = role;
    for (const status of ["draft", "active", "distributing"]) {
      state.cycles[1].status = status;
      for (const path of ["/cycles", "/api/v1/cycles"]) {
        const result = await get(path);
        assert.equal(result.status, 200);
        assert.equal(result.headers["cache-control"], "no-store");
        assert.deepEqual(result.body, { success: true, current_cycle_id: "20", cycles: [state.cycles[1]] });
      }
    }
  }
  state.cycles[1].status = "closed";
  assert.deepEqual((await get()).body, { success: true, current_cycle_id: null, cycles: [] });
  state.cycles = [];
  assert.deepEqual((await get()).body, { success: true, current_cycle_id: null, cycles: [] });
  const sql = state.queries.map(query => query.sql);
  assert.ok(sql.indexOf("SET LOCAL ROLE comsca_group_reader") < sql.findIndex(query => query.includes('from "cycles"')));
});

test("GET cycles rejects unauthenticated, non-manager and cross-group access before reading cycles", async t => {
  const { state, get } = fixture(t);
  for (const path of ["/cycles", "/api/v1/cycles"]) {
    assert.equal((await get(path, { authorization: "" })).status, 401);
    assert.equal((await get(path, { "x-group-slug": "" })).status, 400);
    assert.equal((await get(path, { "x-group-slug": "unknown" })).status, 404);
    assert.equal((await get(path, { "x-group-slug": "beta" })).status, 403);
    for (const role of ["MEMBER", "TREASURER", "AUDITOR", null, "admin"]) {
      state.role = role;
      assert.equal((await get(path)).status, 403);
    }
  }
  state.authError = Object.assign(new Error("Invalid token"), { status: 401 });
  assert.equal((await get()).status, 401);
  assert.equal(state.queries.some(query => query.sql.includes('from "cycles"') || query.sql.includes("SET LOCAL ROLE")), false);
});

test("GET cycles hides database failure details", async t => {
  const { state, get } = fixture(t);
  state.dbError = new Error("Private database details");
  const result = await get();
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { success: false, error: "Internal server error" });
});


test("GET cycles filters before selecting the latest and breaks timestamp ties by ID", async t => {
  const { state, get } = fixture(t);
  const base = state.cycles[1];
  state.cycles = [
    { ...base, id: "100", status: "closed", created_at: "2026-09-25T00:00:00Z" },
    { ...base, id: "99", created_at: "2026-09-19T00:00:00Z" },
    { ...base, id: "9", status: "active" },
    { ...base, id: "10", status: "distributing" },
    { ...base, id: "101", group_id: "2", created_at: "2026-09-26T00:00:00Z" },
  ];
  const result = await get();
  assert.deepEqual(result.body, { success: true, current_cycle_id: "10", cycles: [state.cycles[3]] });
});
