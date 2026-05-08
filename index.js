/**
 * Soniox Text-to-Speech connector for AVR.
 */
const express = require('express');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { once } = require('node:events');

require('dotenv').config();

const app = express();
app.use(express.json({ limit: '1mb' }));

const toOptionalNumber = (value) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const port = Number(process.env.PORT || 6011);

const getRuntimeConfig = () => ({
  sonioxUrl: process.env.SONIOX_TTS_URL || 'https://tts-rt.soniox.com/tts',
  defaultModel: process.env.SONIOX_TTS_MODEL || 'tts-rt-v1',
  defaultVoice: process.env.SONIOX_TTS_VOICE || 'Adrian',
  defaultLanguage: process.env.SONIOX_TTS_LANGUAGE || 'en',
  defaultAudioFormat: process.env.SONIOX_TTS_AUDIO_FORMAT || 'pcm_s16le',
  defaultSampleRate: Number(process.env.SONIOX_TTS_SAMPLE_RATE || 8000),
  defaultBitrate: toOptionalNumber(process.env.SONIOX_TTS_BITRATE),
  upstreamTimeoutMs: toOptionalNumber(process.env.SONIOX_TTS_TIMEOUT_MS) ?? 30000,
});

const makeAbortError = (message, code) => {
  const error = new Error(message);
  error.name = 'AbortError';
  if (code) {
    error.code = code;
  }
  return error;
};

const createAbortSignal = (controller, timeoutMs) => {
  void timeoutMs;
  return controller.signal;
};

const sonioxRequest = ({ url, apiKey, payload, signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const requestBody = JSON.stringify(payload);

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      },
      (upstreamRes) => {
        resolve(upstreamRes);
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        makeAbortError(`Soniox upstream timed out after ${timeoutMs}ms`, 'SONIOX_UPSTREAM_TIMEOUT')
      );
    });

    const onAbort = () => req.destroy(makeAbortError('Request aborted', 'CLIENT_ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });

    req.on('close', () => {
      signal.removeEventListener('abort', onAbort);
    });

    req.write(requestBody);
    req.end();
  });

const waitForDrainOrAbort = async (res, signal) => {
  if (signal.aborted) {
    throw makeAbortError('Response aborted while waiting for drain', 'CLIENT_ABORTED');
  }
  await new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(makeAbortError('Response closed while waiting for drain', 'CLIENT_ABORTED'));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(makeAbortError('Aborted while waiting for drain', 'CLIENT_ABORTED'));
    };
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    res.on('drain', onDrain);
    res.on('close', onClose);
    res.on('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const getTrailerValue = (upstream, trailerName) => {
  const normalizedName = trailerName.toLowerCase();
  if (upstream?.trailers && typeof upstream.trailers === 'object') {
    const fromMap = upstream.trailers[normalizedName];
    if (fromMap !== undefined) return fromMap;
  }
  if (Array.isArray(upstream?.rawTrailers)) {
    for (let i = 0; i < upstream.rawTrailers.length; i += 2) {
      const key = String(upstream.rawTrailers[i] || '').toLowerCase();
      if (key === normalizedName) {
        return upstream.rawTrailers[i + 1];
      }
    }
  }
  return undefined;
};

app.post('/text-to-speech-stream', async (req, res) => {
  const requestId = req.headers['x-uuid'] || 'unknown';
  const apiKey = process.env.SONIOX_API_KEY;
  const {
    sonioxUrl,
    defaultModel,
    defaultVoice,
    defaultLanguage,
    defaultAudioFormat,
    defaultSampleRate,
    defaultBitrate,
    upstreamTimeoutMs,
  } = getRuntimeConfig();

  if (!apiKey) {
    return res.status(500).json({ error: 'SONIOX_API_KEY is not configured' });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }

  const body = {
    model: req.body.model || defaultModel,
    language: req.body.language || defaultLanguage,
    voice: req.body.voice || defaultVoice,
    audio_format: req.body.audio_format || req.body.audioFormat || defaultAudioFormat,
    text,
  };

  const sampleRate = toOptionalNumber(req.body.sample_rate ?? req.body.sampleRate);
  const bitrate = toOptionalNumber(req.body.bitrate) ?? defaultBitrate;

  if (sampleRate !== undefined) {
    body.sample_rate = sampleRate;
  } else if (body.audio_format.startsWith('pcm_')) {
    body.sample_rate = defaultSampleRate;
  }

  if (bitrate !== undefined) {
    body.bitrate = bitrate;
  }

  const controller = new AbortController();
  const abortOnResponseClose = () => {
    if (!res.writableEnded || res.destroyed) {
      controller.abort();
    }
  };
  const abortOnResponseError = () => controller.abort();
  res.on('close', abortOnResponseClose);
  res.on('error', abortOnResponseError);

  let upstream;
  try {
    const signal = createAbortSignal(controller, upstreamTimeoutMs);

    upstream = await sonioxRequest({
      url: sonioxUrl,
      apiKey,
      payload: body,
      signal,
      timeoutMs: upstreamTimeoutMs,
    });

    const statusCode = Number(upstream.statusCode || 500);
    if (statusCode < 200 || statusCode >= 300) {
      let rawErrorPayload = '';
      for await (const chunk of upstream) {
        rawErrorPayload += chunk.toString('utf8');
      }
      let errorPayload;
      try {
        errorPayload = JSON.parse(rawErrorPayload);
      } catch {
        errorPayload = { error_message: rawErrorPayload };
      }
      return res.status(statusCode).json({
        error: 'soniox_tts_request_failed',
        details: errorPayload.error_message || 'Unknown Soniox error',
        code: errorPayload.error_code,
      });
    }

    const contentType =
      (body.audio_format || '').startsWith('pcm_') ? 'audio/l16' : 'application/octet-stream';

    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (!upstream.readable) {
      return res.status(502).json({ error: 'Soniox returned an empty response body' });
    }
    const upstreamEnded = once(upstream, 'end');

    for await (const chunk of upstream) {
      if (controller.signal.aborted || res.writableEnded || res.destroyed) {
        throw makeAbortError('Client disconnected during stream');
      }
      if (!res.write(chunk)) {
        await waitForDrainOrAbort(res, controller.signal);
      }
    }
    await upstreamEnded;

    const trailerCode = getTrailerValue(upstream, 'x-tts-error-code');
    const trailerMessage = getTrailerValue(upstream, 'x-tts-error-message');
    if (trailerCode || trailerMessage) {
      app.emit('soniox-stream-error', {
        requestId,
        trailerCode,
        trailerMessage,
      });
      throw new Error(
        `Soniox trailer error code=${trailerCode || 'unknown'} message=${trailerMessage || 'unknown'}`
      );
    }

    res.end();
  } catch (error) {
    if (controller.signal.aborted) {
      // Client disconnected — avoid noisy connector errors.
      try {
        res.end();
      } catch {}
      return;
    }
    if (error?.code === 'SONIOX_UPSTREAM_TIMEOUT') {
      if (!res.headersSent) {
        return res.status(504).json({
          error: 'soniox_tts_upstream_timeout',
          details: error.message,
        });
      }
      res.destroy(error);
      return;
    }
    if (
      error?.code === 'CLIENT_ABORTED' ||
      error?.code === 'ECONNRESET' ||
      error?.name === 'AbortError'
    ) {
      try {
        res.end();
      } catch {}
      return;
    }
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'soniox_tts_stream_error',
        details: error.message,
      });
    }
    res.destroy(error);
  } finally {
    res.off('close', abortOnResponseClose);
    res.off('error', abortOnResponseError);
    try {
      if (upstream && !upstream.destroyed) {
        upstream.destroy();
      }
    } catch {}
    if (upstream?.trailers?.['x-tts-error-code'] || upstream?.trailers?.['x-tts-error-message']) {
      console.error(
        `[avr-tts-soniox:${requestId}] Upstream trailer code=${upstream.trailers['x-tts-error-code']} message=${upstream.trailers['x-tts-error-message']}`
      );
    }
  }
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`[avr-tts-soniox] listening on ${port}`);
  });
}

module.exports = {
  app,
  sonioxRequest,
  createAbortSignal,
  toOptionalNumber,
  getTrailerValue,
  waitForDrainOrAbort,
};
