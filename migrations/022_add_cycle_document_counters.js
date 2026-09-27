const counters = ["receipt_counter", "disbursement_voucher_counter", "journal_voucher_counter"];

exports.up = async function up(knex) {
  await knex.schema.alterTable("cycles", table => {
    for (const counter of counters) {
      // Last allocated number: zero means no document has been issued.
      table.bigInteger(counter).notNullable().defaultTo(0);
      table.check(`${counter} >= 0`, [], `cycles_${counter}_check`);
    }
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable("cycles", table => {
    table.dropChecks(counters.map(counter => `cycles_${counter}_check`));
    table.dropColumns(...counters);
  });
};
