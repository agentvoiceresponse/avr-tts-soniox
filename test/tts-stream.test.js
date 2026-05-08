const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

process.env.SONIOX_API_KEY = 'test-key';

const { EventEmitter } = require('node:events');
const { app, createAbortSignal, getTrailerValue, waitForDrainOrAbort } = require('../index');

const startServer = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: address.port });
    });
  });

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

test('handles upstream stream that includes trailing headers', async () => {
  const errors = [];
  const onStreamError = (error) => errors.push(error);
  app.on('soniox-stream-error', onStreamError);

  const upstream = net.createServer((socket) => {
    socket.once('data', (requestBuffer) => {
      const rawResponse =
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: audio/pcm\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        'Trailer: X-Tts-Error-Code, X-Tts-Error-Message\r\n' +
        '\r\n' +
        '3\r\n' +
        'abc\r\n' +
        '0\r\n' +
        'X-Tts-Error-Code: 2001\r\n' +
        'X-Tts-Error-Message: simulated trailer failure\r\n' +
        '\r\n';
      socket.write(rawResponse);
      socket.end();
    });
  });
  const upstreamInfo = await startServer(upstream);

  process.env.SONIOX_TTS_URL = `http://127.0.0.1:${upstreamInfo.port}/tts`;
  const connector = http.createServer(app);
  const connectorInfo = await startServer(connector);

  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: connectorInfo.port,
        path: '/text-to-speech-stream',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let chunkCount = 0;
        let aborted = false;
        let ended = false;
        const statusCode = res.statusCode;
        res.on('data', () => {
          chunkCount += 1;
        });
        res.on('aborted', () => {
          aborted = true;
        });
        res.on('end', () => {
          ended = true;
        });
        res.on('error', () => {
          aborted = true;
        });
        res.on('close', () => resolve({ aborted, ended, chunkCount, statusCode }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify({ text: 'hello' }));
  });

  await closeServer(connector);
  await closeServer(upstream);

  app.off('soniox-stream-error', onStreamError);
  assert.equal(result.statusCode, 200);
  assert.equal(result.chunkCount > 0, true);
  assert.equal(result.ended, false);
  assert.equal(errors.length > 0, true);
  assert.equal(errors[0].trailerCode, '2001');
  assert.equal(errors[0].trailerMessage, 'simulated trailer failure');
});

test('reads trailer values from both trailers and rawTrailers', () => {
  assert.equal(
    getTrailerValue({ trailers: { 'x-tts-error-code': '2001' } }, 'x-tts-error-code'),
    '2001'
  );
  assert.equal(
    getTrailerValue({ rawTrailers: ['X-Tts-Error-Message', 'failure'] }, 'x-tts-error-message'),
    'failure'
  );
});

test('streams non-zero bytes and completes cleanly without trailers', async () => {
  const errors = [];
  const onStreamError = (error) => errors.push(error);
  app.on('soniox-stream-error', onStreamError);

  const upstream = net.createServer((socket) => {
    socket.once('data', () => {
      const rawResponse =
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: audio/pcm\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        '\r\n' +
        '5\r\n' +
        'hello\r\n' +
        '0\r\n' +
        '\r\n';
      socket.write(rawResponse);
      socket.end();
    });
  });
  const upstreamInfo = await startServer(upstream);

  process.env.SONIOX_TTS_URL = `http://127.0.0.1:${upstreamInfo.port}/tts`;
  const connector = http.createServer(app);
  const connectorInfo = await startServer(connector);

  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: connectorInfo.port,
        path: '/text-to-speech-stream',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let chunkCount = 0;
        let byteCount = 0;
        let ended = false;
        res.on('data', (chunk) => {
          chunkCount += 1;
          byteCount += chunk.length;
        });
        res.on('end', () => {
          ended = true;
        });
        res.on('close', () => resolve({ statusCode: res.statusCode, chunkCount, byteCount, ended }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify({ text: 'hello' }));
  });

  await closeServer(connector);
  await closeServer(upstream);
  app.off('soniox-stream-error', onStreamError);

  assert.equal(result.statusCode, 200);
  assert.equal(result.chunkCount > 0, true);
  assert.equal(result.byteCount > 0, true);
  assert.equal(result.ended, true);
  assert.equal(errors.length, 0);
});

test('returns deterministic 504 when upstream request times out', async () => {
  const upstream = net.createServer((socket) => {
    socket.once('data', () => {
      // Intentionally keep the socket open and silent to force request timeout.
    });
  });
  const upstreamInfo = await startServer(upstream);

  process.env.SONIOX_TTS_URL = `http://127.0.0.1:${upstreamInfo.port}/tts`;
  process.env.SONIOX_TTS_TIMEOUT_MS = '50';

  const connector = http.createServer(app);
  const connectorInfo = await startServer(connector);

  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: connectorInfo.port,
        path: '/text-to-speech-stream',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify({ text: 'hello' }));
  });

  await closeServer(connector);
  await closeServer(upstream);
  delete process.env.SONIOX_TTS_TIMEOUT_MS;

  const json = JSON.parse(result.body);
  assert.equal(result.statusCode, 504);
  assert.equal(json.error, 'soniox_tts_upstream_timeout');
});

test('waitForDrainOrAbort removes abort listeners across repeated waits', async () => {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;

  const controller = new AbortController();
  const signal = controller.signal;

  const originalAddEventListener = signal.addEventListener.bind(signal);
  const originalRemoveEventListener = signal.removeEventListener.bind(signal);

  let activeAbortListeners = 0;
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') {
      activeAbortListeners += 1;
    }
    return originalAddEventListener(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') {
      activeAbortListeners -= 1;
    }
    return originalRemoveEventListener(type, listener, options);
  };

  for (let i = 0; i < 25; i += 1) {
    const waitPromise = waitForDrainOrAbort(res, signal);
    queueMicrotask(() => res.emit('drain'));
    await waitPromise;
    assert.equal(activeAbortListeners, 0);
  }

  signal.addEventListener = originalAddEventListener;
  signal.removeEventListener = originalRemoveEventListener;
});

test('createAbortSignal enforces absolute timeout abort', async () => {
  const controller = new AbortController();
  createAbortSignal(controller, 20);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason?.code, 'SONIOX_UPSTREAM_TIMEOUT');
});

test('tears down upstream when downstream client disconnects mid-stream', async () => {
  let upstreamSocketClosed = false;

  const upstream = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write(
        'HTTP/1.1 200 OK\r\n' +
          'Content-Type: audio/pcm\r\n' +
          'Transfer-Encoding: chunked\r\n' +
          '\r\n'
      );

      const interval = setInterval(() => {
        if (socket.destroyed) {
          clearInterval(interval);
          return;
        }
        socket.write('2\r\nok\r\n');
      }, 15);

      socket.on('close', () => {
        clearInterval(interval);
        upstreamSocketClosed = true;
      });
    });
  });
  const upstreamInfo = await startServer(upstream);
  process.env.SONIOX_TTS_URL = `http://127.0.0.1:${upstreamInfo.port}/tts`;

  const connector = http.createServer(app);
  const connectorInfo = await startServer(connector);

  await new Promise((resolve, reject) => {
    const client = net.connect(connectorInfo.port, '127.0.0.1');
    client.once('connect', () => {
      const body = JSON.stringify({ text: 'disconnect me' });
      client.write(
        `POST /text-to-speech-stream HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${connectorInfo.port}\r\n` +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          '\r\n' +
          body
      );
    });
    client.once('data', () => {
      client.destroy();
      resolve();
    });
    client.once('error', reject);
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  await closeServer(connector);
  await closeServer(upstream);

  assert.equal(upstreamSocketClosed, true);
});

test('maps upstream ECONNRESET to 502 before headers are sent', async () => {
  const upstream = net.createServer((socket) => {
    socket.once('data', () => {
      socket.destroy();
    });
  });
  const upstreamInfo = await startServer(upstream);

  process.env.SONIOX_TTS_URL = `http://127.0.0.1:${upstreamInfo.port}/tts`;
  const connector = http.createServer(app);
  const connectorInfo = await startServer(connector);

  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: connectorInfo.port,
        path: '/text-to-speech-stream',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify({ text: 'hello' }));
  });

  await closeServer(connector);
  await closeServer(upstream);

  const body = JSON.parse(result.body);
  assert.equal(result.statusCode, 502);
  assert.equal(body.error, 'soniox_tts_upstream_connection_reset');
});
