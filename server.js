import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { render, scan } from './recorder.js';

const PORT = process.env.PORT || 4321;
const ROOT = import.meta.dirname;
const OUT = path.join(ROOT, 'output');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg' };
const jobs = new Map();

// Copies an output file (or a whole render folder) into ~/Downloads. If an identical copy is already there it is
// reused, so clicking Download twice never piles up "file 2", "file 3"…
async function saveToDownloads(src) {
  const st = await fs.promises.stat(src);
  const ext = st.isDirectory() ? '' : path.extname(src);
  const base = path.basename(src, ext);
  for (let n = 1; ; n++) {
    const dest = path.join(DOWNLOADS, n === 1 ? base + ext : `${base} ${n}${ext}`);
    const existing = await fs.promises.stat(dest).catch(() => null);
    if (!existing) {
      await fs.promises.cp(src, dest, { recursive: true });
      return { path: dest, existed: false };
    }
    if (existing.isDirectory() === st.isDirectory() && (st.isDirectory() || existing.size === st.size)) {
      return { path: dest, existed: true };
    }
  }
}

const readJson = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
};

const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

// Range support so <video> can seek (Safari needs it to play at all).
function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, { error: 'Not found' }, 404);
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (!m) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(file).pipe(res);
    }
    const start = m[1] ? +m[1] : st.size - +m[2];
    const end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}` });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

// A failed render must never take the whole app down (the page would then only show "Failed to fetch").
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));
process.on('uncaughtException', (e) => console.error('Uncaught:', e));

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && pathname === '/api/jobs') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let opts;
    try {
      opts = JSON.parse(body);
      if (!/^https?:$/.test(new URL(opts.url).protocol)) throw 0;
    } catch {
      return json(res, { error: 'Please enter a valid http(s) URL.' }, 400);
    }
    const job = { id: randomUUID().slice(0, 8), status: 'running', message: 'Starting…', progress: 0, outputs: [] };
    jobs.set(job.id, job);
    render(opts, OUT, (message, progress) => Object.assign(job, { message, progress }))
      .then(({ dir, outputs }) => Object.assign(job, { status: 'done', message: 'Done', progress: 1, dir, outputs }))
      .catch((e) => {
        console.error(e);
        const msg = e.code === 'ENOSPC' ? 'Your disk is full — free up some space and try again.' : e.message.split('\n')[0];
        Object.assign(job, { status: 'error', message: msg });
      });
    return json(res, { id: job.id });
  }

  if (req.method === 'POST' && pathname === '/api/scan') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const opts = JSON.parse(body);
      if (!/^https?:$/.test(new URL(opts.url).protocol)) throw new Error('Please enter a valid http(s) URL.');
      return json(res, await scan(opts));
    } catch (e) {
      console.error(e);
      return json(res, { error: e.message.split('\n')[0] }, 400);
    }
  }

  if (req.method === 'POST' && pathname === '/api/save') {
    try {
      const { file } = await readJson(req);
      const src = path.join(OUT, file);
      if (!src.startsWith(OUT + path.sep)) return json(res, { error: 'Forbidden' }, 403);
      return json(res, await saveToDownloads(src));
    } catch (e) {
      return json(res, { error: e.code === 'ENOSPC' ? 'Your disk is full.' : `Couldn’t save: ${e.message}` }, 500);
    }
  }

  // Shows a saved file in Finder (only files in Downloads or the output folder).
  if (req.method === 'POST' && pathname === '/api/reveal') {
    const { path: p } = await readJson(req).catch(() => ({}));
    const file = path.resolve(String(p ?? ''));
    if (![DOWNLOADS, OUT].some((dir) => file.startsWith(dir + path.sep))) return json(res, { error: 'Forbidden' }, 403);
    execFile('open', ['-R', file]);
    return json(res, { ok: true });
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/(\w+)(\/reveal)?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, { error: 'Unknown job' }, 404);
    if (jobMatch[2] && job.dir) execFile('open', [job.dir]);
    return json(res, job);
  }

  if (pathname.startsWith('/output/')) {
    const file = path.join(OUT, decodeURIComponent(pathname.slice(8)));
    if (!file.startsWith(OUT + path.sep)) return json(res, { error: 'Forbidden' }, 403);
    return sendFile(req, res, file);
  }

  // The mockup template is also the app's live preview.
  if (pathname.startsWith('/templates/')) {
    const file = path.join(ROOT, decodeURIComponent(pathname));
    if (!file.startsWith(path.join(ROOT, 'templates') + path.sep)) return json(res, { error: 'Forbidden' }, 403);
    return sendFile(req, res, file);
  }

  if (pathname === '/') return sendFile(req, res, path.join(ROOT, 'public/index.html'));
  json(res, { error: 'Not found' }, 404);
});
const url = `http://localhost:${PORT}`;
server.once('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`Site Showcase is already running at ${url}`);
  if (!process.env.NO_OPEN) exec(`open ${url}`);
  process.exit(0);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Site Showcase running at ${url}`);
  if (!process.env.NO_OPEN) exec(`open ${url}`);
});
