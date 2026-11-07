const db = require('./db');
const { createService } = require('./services/tindamate/service');

exports.handler = async () => {
  const service = await createService(db);
  const result = await service.sweepVoidedPurchases();
  console.log('TindaMate voided purchase sweep completed', result);
  return result;
};
