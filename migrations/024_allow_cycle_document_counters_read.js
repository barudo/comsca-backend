const columns = "receipt_counter, disbursement_voucher_counter, journal_voucher_counter";

exports.up = async function up(knex) {
  await knex.raw(`GRANT SELECT (${columns}) ON public.cycles TO comsca_group_reader`);
};

exports.down = async function down(knex) {
  await knex.raw(`REVOKE SELECT (${columns}) ON public.cycles FROM comsca_group_reader`);
};
