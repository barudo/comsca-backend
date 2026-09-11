// The backend connects as the database owner. Supabase's public API roles
// must not get access to application tables without explicit policies.
exports.up = async function up(knex) {
  for (const table of ["groups", "users", "cycles", "cycle_members"]) {
    await knex.raw("ALTER TABLE ?? ENABLE ROW LEVEL SECURITY", [table]);
  }
};

exports.down = async function down(knex) {
  for (const table of ["groups", "users", "cycles", "cycle_members"]) {
    await knex.raw("ALTER TABLE ?? DISABLE ROW LEVEL SECURITY", [table]);
  }
};
