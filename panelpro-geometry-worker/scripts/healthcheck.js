'use strict';
/**
 * Container healthcheck. Plain CommonJS (no build step) so Docker's HEALTHCHECK
 * can run it directly. Exits 0 when the worker answers /healthz, 1 otherwise.
 */
const http = require('node:http');

const port = process.env.PORT || 8080;

const req = http.get(
  { host: '127.0.0.1', port, path: '/healthz', timeout: 4000 },
  (res) => {
    // Drain so the socket closes cleanly.
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);

req.on('error', () => process.exit(1));
req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});
