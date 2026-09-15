/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  // Composite keys let the database enforce group boundaries on references.
  await knex.schema.alterTable("cycles", (table) => {
    table.unique(["group_id", "id"], "cycles_group_id_id_unique");
  });
  await knex.schema.alterTable("users", (table) => {
    table.unique(["group_id", "id"], "users_group_id_id_unique");
  });

  await knex.schema.createTable("transactions", (table) => {
    table.bigIncrements("id").primary();
    table.bigInteger("group_id").notNullable()
      .references("id").inTable("groups").onDelete("RESTRICT");
    table.bigInteger("cycle_id").nullable();
    table.bigInteger("user_id").nullable();
    // An open vocabulary supports additional business operations without DDL.
    table.string("type", 64).notNullable();
    table.decimal("amount", 18, 2).notNullable();
    table.text("description");
    table.timestamp("occurred_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign(["group_id", "cycle_id"], "transactions_group_cycle_fk")
      .references(["group_id", "id"]).inTable("cycles").onDelete("RESTRICT");
    table.foreign(["group_id", "user_id"], "transactions_group_user_fk")
      .references(["group_id", "id"]).inTable("users").onDelete("RESTRICT");
    table.foreign(["cycle_id", "user_id"], "transactions_cycle_member_fk")
      .references(["cycle_id", "user_id"]).inTable("cycle_members").onDelete("RESTRICT");

    table.check("user_id IS NULL OR cycle_id IS NOT NULL", [], "transactions_member_requires_cycle");
    table.check("amount > 0 AND amount <> 'NaN'::numeric", [], "transactions_positive_amount");
    table.check("type ~ '^[A-Z][A-Z0-9_]*$'", [], "transactions_type_format");
    table.index(["group_id", "occurred_at"], "transactions_group_occurred_at_idx");
    table.index(["cycle_id", "user_id"], "transactions_cycle_user_idx");
    table.index(["group_id", "user_id"], "transactions_group_user_idx");
  });

  await knex.raw("ALTER TABLE ?? ENABLE ROW LEVEL SECURITY", ["transactions"]);
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("transactions");
  await knex.schema.alterTable("users", (table) => {
    table.dropUnique(["group_id", "id"], "users_group_id_id_unique");
  });
  await knex.schema.alterTable("cycles", (table) => {
    table.dropUnique(["group_id", "id"], "cycles_group_id_id_unique");
  });
};
