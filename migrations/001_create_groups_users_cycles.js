/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable("groups", (table) => {
    table.bigIncrements("id").primary();
    table.string("slug", 255).notNullable();
    table.unique(["slug"], "groups_slug_unique");
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp("updated_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("users", (table) => {
    table.bigIncrements("id").primary();
    table
      .bigInteger("group_id")
      .notNullable()
      .references("id")
      .inTable("groups")
      .onDelete("CASCADE");
    table.string("username", 255).notNullable();
    table.string("first_name", 255).notNullable();
    table.string("family_name", 255).notNullable();
    table.string("email", 320).notNullable();
    table.string("phone", 32);
    table.string("password", 255).notNullable();
    table.text("address");
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp("updated_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.index(["group_id"], "users_group_id_idx");
  });

  await knex.schema.createTable("cycles", (table) => {
    table.bigIncrements("id").primary();
    table
      .bigInteger("group_id")
      .notNullable()
      .references("id")
      .inTable("groups")
      .onDelete("CASCADE");
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp("updated_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.index(["group_id"], "cycles_group_id_idx");
  });

  await knex.schema.createTable("cycle_members", (table) => {
    table
      .bigInteger("cycle_id")
      .notNullable()
      .references("id")
      .inTable("cycles")
      .onDelete("CASCADE");
    table
      .bigInteger("user_id")
      .notNullable()
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.primary(["cycle_id", "user_id"]);
    table.index(["user_id"], "cycle_members_user_id_idx");
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("cycle_members");
  await knex.schema.dropTableIfExists("cycles");
  await knex.schema.dropTableIfExists("users");
  await knex.schema.dropTableIfExists("groups");
};
