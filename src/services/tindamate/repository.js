const { randomUUID } = require('node:crypto');
const terminal = status => ['REVOKED', 'REFUNDED'].includes(status);
class Repository {
  constructor(db, config = {}) { this.db = db; this.packageName = config.packageName || 'com.vebatech.tindamate'; this.productId = config.productId || 'tindamate_pro_lifetime'; }
  async findToken(session, hash) { return session.transaction(trx => trx('tindamate_google_play_purchases').where({ token_hash: hash }).first()); }
  async findEntitlement(id) {
    return this.db('tindamate_entitlements as e').join('tindamate_google_play_purchases as p', 'p.id', 'e.purchase_id')
      .where('e.id', id).select('p.*').first();
  }
  async withLock(hash, work) {
    const connection = await this.db.client.acquireConnection();
    const key = BigInt('0x' + hash.slice(0, 16));
    const lock = BigInt.asIntN(64, key).toString();
    let originalTimeout;
    let reusable = false;
    try {
      originalTimeout = (await this.db.raw('SHOW statement_timeout').connection(connection)).rows[0].statement_timeout;
      await this.db.raw("SET statement_timeout = '4000ms'").connection(connection);
      await this.db.raw('SELECT pg_advisory_lock(?::bigint)', [lock]).connection(connection);
      return await work({
        transaction: fn => this.db.transaction(fn, { connection }),
      });
    } finally {
      try {
        await this.db.raw('SELECT pg_advisory_unlock(?::bigint)', [lock]).connection(connection);
        if (originalTimeout !== undefined) await this.db.raw("SELECT set_config('statement_timeout', ?, false)", [originalTimeout]).connection(connection);
        reusable = true;
      } finally {
        if (reusable) await this.db.client.releaseConnection(connection);
        else await this.db.client.destroyConnection(connection);
      }
    }
  }
  async persist(session, hash, encrypted, state) {
    return session.transaction(async trx => {
      let p = await trx('tindamate_google_play_purchases').where({ token_hash: hash }).first();
      const status = p && terminal(p.status) ? p.status : state.status;
      const values = { status, last_verified_at: new Date(), revoked_at: terminal(status) ? (p?.revoked_at || new Date()) : null, updated_at: new Date(), acknowledgement_status: state.acknowledged ? 'ACKNOWLEDGED' : (p?.acknowledgement_status || 'PENDING') };
      if (p) [p] = await trx('tindamate_google_play_purchases').where({ id: p.id }).update(values).returning('*');
      else [p] = await trx('tindamate_google_play_purchases').insert({ id: randomUUID(), token_hash: hash, encrypted_token: encrypted, package_name: this.packageName, product_id: this.productId, ...values }).returning('*');
      let e = await trx('tindamate_entitlements').where({ purchase_id: p.id }).first();
      if (terminal(status) && e) [e] = await trx('tindamate_entitlements').where({ id: e.id }).update({ status: 'REVOKED', updated_at: new Date() }).returning('*');
      if (status === 'VERIFIED' && !e) [e] = await trx('tindamate_entitlements').insert({ id: randomUUID(), purchase_id: p.id, status: 'VERIFIED' }).returning('*');
      await trx('tindamate_license_events').insert({ id: randomUUID(), purchase_id: p.id, event_type: status });
      return { purchase: p, entitlement: e };
    });
  }
  async ack(session, id, succeeded) {
    await session.transaction(async trx => { await trx('tindamate_google_play_purchases').where({ id }).update({
      acknowledgement_status: succeeded ? 'ACKNOWLEDGED' : 'RETRY',
      acknowledgement_attempts: this.db.raw('acknowledgement_attempts + 1'), acknowledgement_attempted_at: new Date(), updated_at: new Date(),
    });
      await trx('tindamate_license_events').insert({ id: randomUUID(), purchase_id: id, event_type: succeeded ? 'ACKNOWLEDGED' : 'ACKNOWLEDGEMENT_FAILED' });
    });
  }
  async event(session, key, purchaseId) {
    await session.transaction(trx => trx('tindamate_license_events').insert({ id: randomUUID(), dedupe_key: key, purchase_id: purchaseId, event_type: 'RTDN_PROCESSED' }).onConflict('dedupe_key').ignore());
  }
  async hasEvent(session, key) { return session.transaction(trx => trx('tindamate_license_events').where({ dedupe_key: key }).first()); }
}
module.exports = { Repository, terminal };
