/**
 * server.js — Local HTTP server for MP4 Fragmentizer
 *
 * FFmpeg.wasm requires SharedArrayBuffer, which needs:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * Run with:  node server.js
 * Then open: http://localhost:3000
 *
 * Node.js built-in http module — NO npm install required.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = 3000;
const ROOT = __dirname;

// Check for self-signed certificates to run in HTTPS mode
let useHttps = false;
let sslOptions = {};
try {
  const keyPath = path.join(ROOT, 'key.pem');
  const certPath = path.join(ROOT, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    sslOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    useHttps = true;
  }
} catch (err) {
  console.error('Failed checking/loading certificates:', err.message);
}

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.mp4':  'video/mp4',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

const serverCreator = useHttps ? (handler) => https.createServer(sslOptions, handler) : (handler) => http.createServer(handler);

const server = serverCreator((req, res) => {
  // Parse URL
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);
  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME[ext] || 'application/octet-stream';

  // Security: stay inside ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found: ' + urlPath);
      } else {
        res.writeHead(500); res.end('Server error');
      }
      return;
    }

    // ★ Required headers for FFmpeg.wasm (SharedArrayBuffer)
    res.writeHead(200, {
      'Content-Type':                mimeType,
      'Cross-Origin-Opener-Policy':  'same-origin',
      'Cross-Origin-Embedder-Policy':'require-corp',
      'Cache-Control':               'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const protocol = useHttps ? 'https' : 'http';
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   MP4 Box Patcher — Local Server         ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║   ${protocol}://localhost:${PORT}                  ║`);
  console.log('  ╠══════════════════════════════════════════╣');
  console.log('  ║   Press Ctrl+C to stop                   ║');
  console.log('  ╚══════════════════════════════════════════╝');
  if (useHttps) {
    console.log('  ℹ Running in HTTPS mode (Secure Context).');
    console.log('    Other devices on your Tailscale network can now connect');
    console.log('    and load WebAssembly! Just bypass the browser SSL warning.');
  }
  console.log('');

  // Auto-open browser
  const { exec } = require('child_process');
  exec(`start ${protocol}://localhost:${PORT}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use.`);
    console.error(`  Try:  node server.js  (after closing whatever uses port ${PORT})\n`);
  } else {
    console.error('\n  Server error:', err.message, '\n');
  }
  process.exit(1);
});
