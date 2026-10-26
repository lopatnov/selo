'use strict';

const express = require('express');

const { ProviderError } = require('./meterless-runtime');

function statusForError(error) {
  switch (error.code) {
    case 'unauthorized':
      return 401;
    case 'invalid_token':
    case 'invalid_url':
    case 'invalid_connect_link':
    case 'invalid_request':
      return 400;
    case 'offline':
      return 502;
    default:
      return 500;
  }
}

function createProvidersRouter({ runtime, providers = [] }) {
  const router = express.Router();

  const asyncRoute = handler => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

  function sendConfigWithStatus(res, extra = {}) {
    return runtime.getStatus().then(status => {
      res.json({ ...runtime.getConfig(), ...extra, status });
    });
  }

  router.get('/', (req, res) => {
    res.json(
      providers.map(provider =>
        typeof provider.descriptor === 'function' ? provider.descriptor() : provider
      )
    );
  });

  router.get(
    '/meterless',
    asyncRoute(async (req, res) => {
      await sendConfigWithStatus(res);
    })
  );

  router.put(
    '/meterless/config',
    asyncRoute(async (req, res) => {
      const { baseUrl, token } = req.body || {};

      try {
        runtime.saveConfig({ baseUrl, token });
      } catch (error) {
        if (error instanceof ProviderError) {
          return res.status(statusForError(error)).json({ error: error.message, code: error.code });
        }
        throw error;
      }

      await sendConfigWithStatus(res);
    })
  );

  router.post(
    '/meterless/detect',
    asyncRoute(async (req, res) => {
      const result = await runtime.autoDetect();
      const status = await runtime.getStatus();
      res.json({
        ...result,
        // `result.status` is the detection result (online/unauthorized/offline).
        // Keep it under its own key because `status` below is the full probe
        // object used by the rest of the page.
        detectionStatus: result.status,
        config: runtime.getConfig(),
        status
      });
    })
  );

  router.post(
    '/meterless/connect',
    asyncRoute(async (req, res) => {
      const link = req.body?.link;
      if (!link || typeof link !== 'string') {
        return res.status(400).json({ error: 'A connect link is required.', code: 'invalid_connect_link' });
      }

      try {
        runtime.connect(link);
      } catch (error) {
        return res
          .status(statusForError(error))
          .json({ error: error.message, code: error.code || 'invalid_connect_link' });
      }

      await sendConfigWithStatus(res);
    })
  );

  router.get(
    '/meterless/models',
    asyncRoute(async (req, res) => {
      res.json(await runtime.listModels());
    })
  );

  router.get(
    '/meterless/health',
    asyncRoute(async (req, res) => {
      res.json(await runtime.checkHealth());
    })
  );

  router.post(
    '/meterless/chat',
    asyncRoute(async (req, res) => {
      const { model, messages, ...options } = req.body || {};

      try {
        const content = await runtime.chat({ model, messages, ...options });
        res.json({
          model: model || 'meterless/auto',
          content,
          contentType: typeof content
        });
      } catch (error) {
        if (error instanceof ProviderError) {
          return res
            .status(statusForError(error))
            .json({ error: error.message, code: error.code });
        }
        throw error;
      }
    })
  );

  return router;
}

module.exports = {
  createProvidersRouter
};
