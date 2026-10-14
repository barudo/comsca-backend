const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const migration = require("../migrations/034_add_expense_payment_status");

test("expense payment status migration preserves history, defaults new expenses and rolls back", {
  skip: !process.env.TEST_DATABASE_URL,
}, async t => {
  const admin = knex({ client: "pg", connection: process.env.TEST_DATABASE_URL });
  const name = `expense_status_${process.pid}_${Date.now()}`;
  let created = false;
  let db;
  t.after(async () => {
    try {
      if (db) await db.destroy();
      if (created) await admin.raw("DROP DATABASE ??", [name]);
    } finally {
      await admin.destroy();
    }
  });
  await admin.raw("CREATE DATABASE ??", [name]);
  created = true;
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  db = knex({ client: "pg", connection: url.toString() });
  await db.schema.createTable("transactions", table => {
    table.bigIncrements("id");
    table.string("type", 64).notNullable();
    table.text("description");
  });
  const [legacy] = await db("transactions").insert({ type: "EXPENSE" }).returning("id");
  await db("transactions").insert({ type: "DONATION" });
  await db.transaction(trx => migration.up(trx));
  assert.ok((await db("transactions")).every(row => row.expense_payment_status === null));
  // An unrelated update must not silently classify legacy expenses as unpaid.
  await db("transactions").where({ id: legacy.id }).update({ description: "Reconcile later" });
  assert.equal((await db("transactions").where({ id: legacy.id }).first()).expense_payment_status, null);
  for (const input of [{ type: "EXPENSE" }, { type: "EXPENSE", expense_payment_status: null }]) {
    const [row] = await db("transactions").insert(input).returning("*");
    assert.equal(row.expense_payment_status, "UNPAID");
    await db("transactions").where({ id: row.id }).update({ expense_payment_status: "PAID" });
    assert.equal((await db("transactions").where({ id: row.id }).first()).expense_payment_status, "PAID");
  }
  const [paid] = await db("transactions").insert({ type: "EXPENSE", expense_payment_status: "PAID" }).returning("*");
  assert.equal(paid.expense_payment_status, "PAID");
  const [donation] = await db("transactions").insert({ type: "DONATION" }).returning("*");
  assert.equal(donation.expense_payment_status, null);
  for (const input of [
    { type: "EXPENSE", expense_payment_status: "PARTIALLY_PAID" },
    { type: "EXPENSE", expense_payment_status: "paid" },
    { type: "DONATION", expense_payment_status: "UNPAID" },
    { type: "PAYMENT", expense_payment_status: "PAID" },
  ]) {
    await assert.rejects(db("transactions").insert(input), { code: "23514" });
  }
  await assert.rejects(db("transactions").where({ id: paid.id }).update({ type: "DONATION" }), { code: "23514" });
  await db("transactions").where({ id: legacy.id }).update({ expense_payment_status: "PAID" });
  await db.transaction(trx => migration.down(trx));
  assert.equal(await db.schema.hasColumn("transactions", "expense_payment_status"), false);
  await db("transactions").insert({ type: "EXPENSE" });
  await db.transaction(trx => migration.up(trx));
  assert.ok((await db("transactions")).every(row => row.expense_payment_status === null));
});
