import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { build, buildDirectory } from './build.mjs';

const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535.');
}
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

await build();

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'serial=(self)');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'self'",
  );
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed.');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Invalid URL encoding.');
    return;
  }
  if (pathname.includes('\0')) {
    response.writeHead(400).end('Invalid path.');
    return;
  }
  const requestedFile = resolve(buildDirectory, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!requestedFile.startsWith(`${buildDirectory}${sep}`)) {
    response.writeHead(403).end('Access denied.');
    return;
  }

  try {
    const file = await realpath(requestedFile);
    if (!file.startsWith(`${buildDirectory}${sep}`)) {
      response.writeHead(403).end('Access denied.');
      return;
    }
    const details = await stat(file);
    if (!details.isFile()) {
      response.writeHead(404).end('Not found.');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'Content-Length': details.size,
    });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      await pipeline(createReadStream(file), response);
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      response.writeHead(404).end('Not found.');
    } else if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      console.warn('Browser closed an unfinished response.');
    } else {
      console.error('Static server error:', error);
      if (!response.headersSent) {
        response.writeHead(500).end('Unable to read the requested file.');
      } else {
        response.destroy(error);
      }
    }
  }
});

server.on('error', (error) => {
  console.error('Unable to start the VT100 server:', error);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`VT100 console: http://localhost:${port}`);
  console.log('Remote VS Code: forward this port, then open localhost in your device-connected browser.');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
    server.closeIdleConnections();
  });
}
