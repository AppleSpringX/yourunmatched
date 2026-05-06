// HTTPS-fronted proxy to the wispbyte backend.
// Render gives us *.onrender.com with HTTPS; wispbyte runs the actual Node app on HTTP.
// All paths and methods are forwarded transparently. No auth here — backend handles it.

import http from 'node:http';

const ORIGIN_HOST = 'yourunmatched.duckdns.org';
const ORIGIN_PORT = 9255;
const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  // Health check passthrough at the proxy level too — useful for Render's monitoring.
  if (req.url === '/proxy-health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"layer":"proxy"}');
    return;
  }

  // Strip 'host' so upstream sees its own host header (avoids Fastify routing surprises).
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];

  const proxyReq = http.request(
    {
      host: ORIGIN_HOST,
      port: ORIGIN_PORT,
      path: req.url,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error('[proxy] upstream error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('Backend unreachable: ' + err.message);
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`[proxy] listening on :${PORT} → http://${ORIGIN_HOST}:${ORIGIN_PORT}`);
});
