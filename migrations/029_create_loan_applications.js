exports.up = async function up(knex) {
  await knex.schema.createTable("loan_applications", (table) => {
    table.bigIncrements("id").primary();
    table.bigInteger("group_id").notNullable();
    table.bigInteger("user_id").notNullable();
    table.bigInteger("cycle_id").notNullable();
    table.decimal("amount_desired", 18, 2).notNullable();
    table.decimal("amount_disbursed", 18, 2).notNullable().defaultTo(0);
    table.string("status", 16).notNullable().defaultTo("active");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.foreign(["group_id", "user_id"]).references(["group_id", "id"]).inTable("users").onDelete("RESTRICT");
    table.foreign(["group_id", "cycle_id"]).references(["group_id", "id"]).inTable("cycles").onDelete("RESTRICT");
    table.foreign(["cycle_id", "user_id"]).references(["cycle_id", "user_id"]).inTable("cycle_members").onDelete("RESTRICT");
    table.check("amount_desired > 0 AND amount_desired <> 'NaN'::numeric");
    table.check("amount_disbursed >= 0 AND amount_disbursed <> 'NaN'::numeric");
    table.check("status IN ('active', 'deleted')");
    table.index(["group_id", "cycle_id", "user_id"]);
  });
  await knex.raw("ALTER TABLE ?? ENABLE ROW LEVEL SECURITY", ["loan_applications"]);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("loan_applications");
};
