const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const knex = require('knex');
const migration = require('../migrations/039_create_tindamate_licensing');
const mobileMigration = require('../migrations/040_tindamate_mobile_contract');
const revocationMigration = require('../migrations/041_tindamate_revocation_reason');
const { Repository } = require('../src/services/tindamate/repository');
// Only explicitly supplied test server credentials are used. Always create a new database.
test('actual PostgreSQL migration, unique constraints, RLS, concurrency and rollback', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const admin = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 1 } });
  const name = 'tindamate_test_' + crypto.randomBytes(8).toString('hex');
  let db;
  try {
    await admin.raw('CREATE DATABASE ??', [name]);
    const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = '/' + name;
    db = knex({ client: 'pg', connection: url.toString(), pool: { min: 0, max: 2 } });
    await migration.up(db); await mobileMigration.up(db); await revocationMigration.up(db); const repository = new Repository(db); const hash = 'a'.repeat(64);
    const results = await Promise.all(Array.from({ length: 4 }, () => repository.withLock(hash, s => repository.persist(s, hash, 'ciphertext', { status: 'VERIFIED' }))));
    assert.equal(new Set(results.map(r => r.entitlement.id)).size, 1);
    assert.equal((await db('tindamate_google_play_purchases')).length, 1);
    const revokedAt = new Date('2026-01-02T00:00:00Z');
    await repository.withLock(hash, s => repository.persist(s, hash, 'ciphertext', { status: 'REFUNDED', reason: 'GOOGLE_PLAY_VOIDED_7', revokedAt }));
    const revoked = await db('tindamate_google_play_purchases').where({ token_hash: hash }).first();
    assert.equal(revoked.revocation_reason, 'GOOGLE_PLAY_VOIDED_7');
    assert.equal(revoked.revoked_at.toISOString(), revokedAt.toISOString());
    assert.equal((await db('tindamate_entitlements').first()).status, 'REVOKED');
    await assert.rejects(db('tindamate_google_play_purchases').insert({ id: crypto.randomUUID(), token_hash: hash, encrypted_token: 'x', status: 'VERIFIED' }), /unique/);
    await assert.rejects(db('tindamate_google_play_purchases').where({ token_hash: hash }).update({ status: 'BAD' }), /check/);
    const rls = await db.raw("SELECT relrowsecurity FROM pg_class WHERE relname LIKE 'tindamate_%' AND relkind='r'"); assert(rls.rows.every(r => r.relrowsecurity));
    await db.raw("CREATE FUNCTION fail_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rollback-test'; END $$; CREATE TRIGGER fail_entitlement BEFORE INSERT ON tindamate_entitlements FOR EACH ROW EXECUTE FUNCTION fail_entitlement()");
    await assert.rejects(repository.withLock('b'.repeat(64), s => repository.persist(s, 'b'.repeat(64), 'cipher', { status: 'VERIFIED' })), /rollback-test/);
    assert.equal((await db('tindamate_google_play_purchases')).length, 1);
    await migration.down(db); assert.equal(await db.schema.hasTable('tindamate_google_play_purchases'), false);
  } finally {
    if (db) await db.destroy();
    await admin.raw('DROP DATABASE IF EXISTS ??', [name]); await admin.destroy();
  }
});
