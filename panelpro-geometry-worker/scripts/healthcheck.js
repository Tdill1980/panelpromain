// Container healthcheck (ESM — the package is type:module). Exits 0 when the
// worker answers /healthz, 1 otherwise. No build step; run directly by Docker.
import http from 'node:http';

const port = process.env.PORT || 8080;

const req = http.get(
  { host: '127.0.0.1', port, path: '/healthz', timeout: 4000 },
  (res) => {
    res.resume(); // drain so the socket closes cleanly
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);

req.on('error', () => process.exit(1));
req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});
