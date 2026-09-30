import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VIRTUAL_TIME = path.join(import.meta.dirname, 'virtual-time.js');
const TEMPLATE = pathToFileURL(path.join(import.meta.dirname, 'templates/mockup.html')).href;
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync) ?? 'ffmpeg';

export const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  laptop: { viewport: { width: 1280, height: 800 } },
  tablet: { viewport: { width: 834, height: 1194 }, isMobile: true, hasTouch: true, userAgent: devices['iPad Pro 11'].userAgent },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: devices['iPhone 13'].userAgent },
};
export const FORMATS = { '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920] };
export const STYLES = ['browser-light', 'browser-dark', 'floating', 'perspective', 'macbook', 'iphone'];

const HIDE_CSS = `
::-webkit-scrollbar { display: none !important; }
html { scrollbar-width: none !important; }`;
const COOKIE_CSS = `
#onetrust-consent-sdk, #onetrust-banner-sdk, #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay, #usercentrics-root,
#didomi-host, .qc-cmp2-container, #truste-consent-track, #hs-eu-cookie-confirmation, .osano-cm-window, #cookiescript_injected,
.cky-consent-container, .cky-overlay, #cookie-law-info-bar, .cc-window, .cc-banner, .fc-consent-root, #gdpr-cookie-message,
#cookie-banner, .cookie-banner, #cookie-consent, .cookie-consent, [class*="cookie-banner" i], [id*="cookie-banner" i],
[class*="cookieconsent" i], [id*="cookieconsent" i], [aria-label*="cookie" i][role="dialog"],
#intercom-container, .intercom-lightweight-app, #crisp-chatbox, #hubspot-messenger-iframe-container, .drift-frame-controller,
#tidio-chat, iframe[title*="chat" i] { display: none !important; }`;

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pipes JPEG frames straight into ffmpeg, so nothing extra touches the disk.
async function encode(out, fps, count, getFrame) {
  const p = spawn(FFMPEG, ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', out]);
  let err = '';
  p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
  const done = new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code ? reject(new Error(`ffmpeg failed:\n${err}`)) : resolve()));
  });
  for (let i = 0; i < count; i++) {
    if (!p.stdin.write(await getFrame(i))) await once(p.stdin, 'drain');
  }
  p.stdin.end();
  await done;
}

// Headless (no window). Full Chromium + Metal GPU renders WebGL far faster than headless-shell's software GL.
const launch = () => chromium.launch({
  channel: 'chromium',
  args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});

async function openPage(browser, o, report) {
  const device = DEVICES[o.device] ?? DEVICES.desktop;
  const { width: vw, height: vh } = device.viewport;
  const context = await browser.newContext({ ...device, deviceScaleFactor: o.retina ? 2 : 1, reducedMotion: 'no-preference' });
  const css = HIDE_CSS + (o.hideCookies ? COOKIE_CSS : '');
  await context.addInitScript((css) => {
    const add = () => document.documentElement.append(Object.assign(document.createElement('style'), { textContent: css }));
    document.documentElement ? add() : document.addEventListener('DOMContentLoaded', add);
  }, css);
  await context.addInitScript({ path: VIRTUAL_TIME });
  const page = await context.newPage();

  report?.('Loading page…', 0.02);
  await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);

  // Custom consent banners slip past the selector list: hide small fixed/sticky boxes that talk about cookies.
  const sweep = () => o.hideCookies && page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      const { position } = getComputedStyle(el);
      if ((position === 'fixed' || position === 'sticky') && el.textContent.length < 3000
        && /cookie|consent|gdpr/i.test(el.textContent) && el.querySelector('button, a')) {
        el.style.setProperty('display', 'none', 'important');
      }
    }
  }).catch(() => {});
  await sweep();

  // Find what actually scrolls: usually the document, sometimes an inner container.
  const max = await page.evaluate(() => {
    let el = document.scrollingElement;
    if (el.scrollHeight - el.clientHeight < 50) {
      let best = 0;
      for (const e of document.querySelectorAll('body *')) {
        const s = getComputedStyle(e).overflowY;
        if ((s === 'auto' || s === 'scroll') && e.scrollHeight - e.clientHeight > best) {
          best = e.scrollHeight - e.clientHeight;
          el = e;
        }
      }
    }
    window.__sc = el;
    return el.scrollHeight - el.clientHeight;
  });
  return { context, page, sweep, max, vw, vh };
}

// Section tops (long sections get extra stops one screen apart); the last stop is always the bottom.
const findStops = (page) => page.evaluate(() => {
  const el = window.__sc;
  const vh = el.clientHeight;
  const max = el.scrollHeight - vh;
  const base = el === document.scrollingElement ? 0 : el.getBoundingClientRect().top;
  const tops = [...document.querySelectorAll('section, main > *, body > *, body > * > *, .pin-spacer')]
    .filter((e) => e.offsetHeight > vh * 0.4)
    .map((e) => Math.round(e.getBoundingClientRect().top - base + el.scrollTop))
    .concat(max)
    .filter((y) => y > 0 && y <= max)
    .sort((a, b) => a - b);
  const stops = [];
  let last = 0;
  for (const y of tops) {
    while (y - last > vh * 1.3) stops.push((last += vh));
    if (y - last > vh * 0.35) stops.push((last = y));
  }
  if (stops.length) stops[stops.length - 1] = max;
  return stops;
});

// Pins the scroll position for `seconds` of page time, re-applying it every frame so smooth-scroll/snap
// libraries (e.g. Lenis snapping) can't pull the page elsewhere while animations settle.
async function holdAt(page, y, seconds) {
  await page.evaluate(() => window.__vt.start()); // no-op if the clock is already virtual
  for (let k = 0; k < Math.round(seconds * 30); k++) {
    await page.evaluate((y) => window.__vt.step(1000 / 30, { from: y, to: y, p: 1 }), y);
  }
}

const ease = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

// Scroll-triggered sites can show different content depending on how you arrive (direction, speed, pauses),
// so reach `y` exactly the way the video does: from the top, through the same stops and pauses.
async function approach(page, y, plan, speed) {
  const stepTo = async (from, to, seconds) => {
    const n = Math.max(1, Math.round(seconds * 30));
    for (let k = 1; k <= n; k++) {
      await page.evaluate(([from, to, p]) => window.__vt.step(1000 / 30, { from, to, p }), [from, to, ease(k / n)]);
    }
  };
  await holdAt(page, 0, plan[0]?.pause ?? 0.5);
  let at = 0;
  for (const stop of [...plan.slice(1).filter((s) => s.y < y - 1), { y, pause: 2.5 }]) {
    await stepTo(at, stop.y, Math.max(0.8, (stop.y - at) / speed));
    await holdAt(page, stop.y, stop.pause);
    at = stop.y;
  }
}

// Detects the sections and returns a preview image of each, so the user can set per-section pauses.
export async function scan(o) {
  const browser = await launch();
  try {
    const { page, sweep, max, vw, vh } = await openPage(browser, { ...o, retina: false });
    const sections = [];
    await sleep(1000);
    await sweep();
    for (const y of [0, ...(max > 50 ? await findStops(page) : [])]) {
      await holdAt(page, y, 1.2);
      const img = await page.screenshot({ type: 'jpeg', quality: 70 });
      sections.push({ y, thumb: `data:image/jpeg;base64,${img.toString('base64')}` });
    }
    return { sections, max, width: vw, height: vh };
  } finally {
    await browser.close();
  }
}

async function capture(browser, o, fps, framesDir, report) {
  const { context, page, sweep, max, vw, vh } = await openPage(browser, o, report);
  const speed = clamp(o.speed, 100, 3000, 600);
  const backDur = clamp(max / speed / 2, 1, 3, 2);

  // The plan: where to stop and how long to stay. Index 0 is the hero (top of the page).
  let plan;
  let continuous = false;
  if (Array.isArray(o.sections) && o.sections.length) {
    // From a scan: sections with 0s are scrolled through without stopping.
    const all = o.sections
      .map((s) => ({ y: clamp(s.y, 0, max, 0), pause: clamp(s.pause, 0, 30, 0) }))
      .sort((a, b) => a.y - b.y);
    plan = all.filter((s, i) => i === 0 || i === all.length - 1 || s.pause > 0);
    plan[0].y = 0;
  } else {
    const startDelay = clamp(o.startDelay, 0, 15, 2);
    const endPause = clamp(o.endPause, 0, 10, 1);
    const sectionPause = clamp(o.sectionPause, 0, 10, 0);
    continuous = !sectionPause;
    const stops = max <= 50 ? [] : continuous ? [max] : await findStops(page);
    plan = [{ y: 0, pause: startDelay }, ...stops.map((y) => ({ y, pause: sectionPause }))];
    plan.at(-1).pause = endPause;
  }

  // Timeline of segments; each is rendered frame by frame on the page's virtual clock.
  const segments = [{ dur: plan[0].pause, sweep: true }];
  for (let i = 1; i < plan.length; i++) {
    const move = continuous
      ? clamp(max / speed, 2, clamp(o.maxDuration, 5, 120, 30), 10)
      : Math.max(0.8, (plan[i].y - plan[i - 1].y) / speed);
    segments.push({ dur: move, to: i === plan.length - 1 ? 'max' : plan[i].y }, { dur: plan[i].pause });
  }
  if (o.scrollBack && plan.length > 1) segments.push({ dur: backDur, to: 0 }, { dur: 0.6 });
  const length = segments.reduce((n, s) => n + s.dur, 0);
  const total = segments.reduce((n, s) => n + Math.round(s.dur * fps), 0);

  const frames = [];
  const shoot = async () => {
    const file = path.join(framesDir, `raw_${String(frames.length).padStart(5, '0')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
    frames.push({ file, t: frames.length / fps });
    if (frames.length % 15 === 0) {
      report(`Capturing frame ${frames.length}/${total} (${Math.round(length)}s video, ${plan.length - 1} stops)…`,
        0.05 + (0.3 * frames.length) / total);
    }
  };
  const scrollMax = () => page.evaluate(() => window.__sc.scrollHeight - window.__sc.clientHeight);

  if (o.video === false) {
    report('Loading animations…', 0.1);
    await sleep(Math.min(plan[0].pause, 5) * 1000);
    await sweep();
  } else {
    if (o.method === 'wheel') await page.mouse.move(vw / 2, vh / 2);
    await page.evaluate(() => window.__vt.start());
    await shoot();
    for (const seg of segments) {
      const n = Math.round(seg.dur * fps);
      const from = seg.to === undefined ? null : await page.evaluate(() => window.__sc.scrollTop);
      const wheelTo = seg.to === 'max' ? await scrollMax() : seg.to;
      for (let k = 1; k <= n; k++) {
        let scroll = null;
        if (from !== null && o.method === 'wheel') {
          await page.mouse.wheel(0, (wheelTo - from) * (ease(k / n) - ease((k - 1) / n)));
        } else if (from !== null) {
          scroll = { from, to: seg.to, p: ease(k / n) };
        }
        await page.evaluate(([dt, scroll]) => window.__vt.step(dt, scroll), [1000 / fps, scroll]);
        await shoot();
      }
      if (seg.sweep) await sweep();
    }
  }

  // Still images for thumbnails: at the section the user picked, else `shotAt` screens down.
  report('Taking screenshots…', 0.3);
  const shotY = Number.isFinite(+o.shotY) ? clamp(o.shotY, 0, max, 0) : clamp(o.shotAt, 0, 10, 0) * vh;
  await approach(page, shotY, plan, speed);
  const hero = path.join(framesDir, 'hero.png');
  await page.screenshot({ path: hero });
  await page.evaluate(() => window.__vt.stop());
  if (o.video === false) {
    // Pass through the page once so scroll-triggered sections are revealed for the full-page shot.
    await page.evaluate(async () => {
      const el = window.__sc;
      for (let y = 0; y < el.scrollHeight - el.clientHeight; y += el.clientHeight / 2) {
        el.scrollTop = y;
        await new Promise((r) => setTimeout(r, 120));
      }
      el.scrollTop = el.scrollHeight;
      await new Promise((r) => setTimeout(r, 500));
    });
  }
  let fullpage = null;
  try {
    fullpage = path.join(framesDir, 'fullpage.png');
    await page.screenshot({ path: fullpage, fullPage: true, timeout: 30_000 });
  } catch {
    fullpage = null;
  }
  await context.close();
  return { frames, hero, fullpage, ar: vw / vh };
}

async function mockupPages(browser, n, cfg, dpr) {
  return Promise.all(Array.from({ length: n }, async () => {
    const page = await browser.newPage({ viewport: { width: cfg.W, height: cfg.H }, deviceScaleFactor: dpr });
    await page.goto(TEMPLATE);
    await page.evaluate((c) => window.setup(c), cfg);
    return page;
  }));
}

export async function render(o, outRoot, report) {
  const url = new URL(o.url);
  const host = url.hostname.replace(/^www\./, '');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  outRoot = path.resolve(outRoot);
  const dir = path.join(outRoot, `${host}-${stamp}`);
  const framesDir = path.join(dir, '.frames');
  await fs.mkdir(framesDir, { recursive: true });
  const fps = o.fps == 30 ? 30 : 60;
  const [W, H] = FORMATS[o.format] ?? FORMATS['16:9'];
  const outputs = [];
  const add = (file, kind, label) => outputs.push({ file: path.relative(outRoot, file), kind, label });

  const browser = await launch();
  try {
    const cap = await capture(browser, o, fps, framesDir, report);
    const seq = cap.frames.map((_, i) => i); // one captured frame per video frame
    const video = o.video !== false;

    if (video) {
      report('Encoding scroll video…', 0.35);
      const raw = path.join(dir, `${host}-scroll.mp4`);
      await encode(raw, fps, seq.length, (i) => fs.readFile(cap.frames[seq[i]].file));
      add(raw, 'video', 'Scroll video');
    }

    if (o.fullscreen) {
      const file = path.join(dir, `${host}-fullscreen.png`);
      await fs.copyFile(cap.hero, file);
      add(file, 'image', 'Full-screen screenshot');
    }

    const base = { W, H, ar: cap.ar, bg: typeof o.background === 'object' ? o.background : 'aurora', url: host };
    const fits = (s) => (s === 'iphone' ? cap.ar < 1 : s === 'macbook' ? cap.ar > 1 : true);

    if (o.thumbnails) {
      const styles = STYLES.filter(fits);
      for (const [i, style] of styles.entries()) {
        report(`Thumbnail: ${style}…`, 0.4 + (0.1 * i) / styles.length);
        const [page] = await mockupPages(browser, 1, { ...base, style }, 2);
        await page.evaluate((src) => window.setFrame(src), pathToFileURL(cap.hero).href);
        const file = path.join(dir, `${host}-thumb-${style}.jpg`);
        await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
        await page.close();
        add(file, 'image', `Thumbnail · ${style}`);
      }
    }

    if (video && o.style && o.style !== 'none') {
      // A pool of template pages renders frames ahead of the encoder; results are consumed in order.
      const pool = await mockupPages(browser, 4, { ...base, style: o.style }, 1);
      const waiting = [];
      const acquire = () => (pool.length ? pool.pop() : new Promise((r) => waiting.push(r)));
      const release = (p) => (waiting.length ? waiting.shift()(p) : pool.push(p));
      const rendered = new Map();
      const renderFrame = (idx) => {
        if (!rendered.has(idx)) {
          const job = (async () => {
            const page = await acquire();
            try {
              await page.evaluate((src) => window.setFrame(src), pathToFileURL(cap.frames[idx].file).href);
              return await page.screenshot({ type: 'jpeg', quality: 93 });
            } finally {
              release(page);
            }
          })();
          job.catch(() => {}); // prefetched frames may be dropped unread; their errors must not crash the server
          rendered.set(idx, job);
        }
        return rendered.get(idx);
      };
      const mock = path.join(dir, `${host}-mockup-${o.style}.mp4`);
      await encode(mock, fps, seq.length, (i) => {
        for (let k = i; k < Math.min(i + 24, seq.length); k++) renderFrame(seq[k]);
        for (const key of rendered.keys()) if (key < seq[i]) rendered.delete(key);
        if (i % 20 === 0) report(`Rendering mockup video ${Math.round((100 * i) / seq.length)}%…`, 0.5 + (0.48 * i) / seq.length);
        return renderFrame(seq[i]);
      });
      add(mock, 'video', `Mockup video · ${o.style}`);
    }

    if (cap.fullpage) {
      const file = path.join(dir, `${host}-fullpage.png`);
      await fs.rename(cap.fullpage, file);
      add(file, 'image', 'Full-page screenshot');
    }
    return { dir, outputs };
  } finally {
    await browser.close();
    await fs.rm(framesDir, { recursive: true, force: true });
  }
}
