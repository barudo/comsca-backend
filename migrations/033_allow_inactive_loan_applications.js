exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE loan_applications
    DROP CONSTRAINT loan_applications_status_check,
    ADD CONSTRAINT loan_applications_status_check
      CHECK (status IN ('active', 'inactive', 'deleted'))`);
};

exports.down = async function down(knex) {
  // Refuse rollback while inactive history exists rather than reactivate it.
  await knex.raw(`ALTER TABLE loan_applications
    DROP CONSTRAINT loan_applications_status_check,
    ADD CONSTRAINT loan_applications_status_check
      CHECK (status IN ('active', 'deleted'))`);
};
