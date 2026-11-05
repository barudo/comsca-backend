const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { createService } = require('../services/tindamate/service');
const { LicensingError } = require('../services/tindamate/config');
module.exports = function licensingRouter(database) {
  const router = express.Router();
  let service;
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many requests' } }));
  router.use(express.json({ limit: '16kb', strict: true }));
  for (const [paths, method] of [
    [['/verify', '/restore', '/v1/google-play/verify'], 'verify'],
    [['/reconcile', '/v1/google-play/reconcile'], 'reconcile'], [['/rtdn'], 'rtdn'],
  ]) router.post(paths, async (req, res) => {
    try {
      if (!req.is('application/json') || !req.body || Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid request' });
      const active = req.app.locals.services?.tindamate || (service ||= createService(database));
      return res.json(await active[method](req.body, req.get('authorization')));
    } catch (error) {
      return res.status(error instanceof LicensingError ? error.status : 503).json({ error: error instanceof LicensingError ? error.message : 'Licensing unavailable' });
    }
  });
  router.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  router.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request body' }));
  return router;
};
