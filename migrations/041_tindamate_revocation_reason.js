exports.up = async knex => {
  await knex.schema.alterTable('tindamate_google_play_purchases', table => {
    table.text('revocation_reason');
  });
};

exports.down = async knex => {
  await knex.schema.alterTable('tindamate_google_play_purchases', table => {
    table.dropColumn('revocation_reason');
  });
};
