// Injected before any page script. The page runs on real time until __vt.start(); after that its clock
// (rAF, timers, performance.now, Date.now, CSS/Web animations, videos) only moves when the recorder calls
// __vt.step(ms). Every frame is then rendered exactly on schedule, however long each screenshot takes.
(() => {
  const real = {
    raf: window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame.bind(window),
    now: performance.now.bind(performance),
    dateNow: Date.now,
    setTimeout: window.setTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  };
  let on = false;
  let now = 0;
  let dateBase = 0;
  let nextId = 1e9; // far from real ids, so cancel/clear never hits the wrong callback
  let frameCallbacks = new Map();
  const timers = new Map();
  const animStart = new WeakMap();
  const playingVideos = new Set();

  window.requestAnimationFrame = (cb) => {
    if (!on) return real.raf(cb);
    frameCallbacks.set(nextId, cb);
    return nextId++;
  };
  window.cancelAnimationFrame = (id) => {
    frameCallbacks.delete(id);
    real.caf(id);
  };
  performance.now = () => (on ? now : real.now());
  Date.now = () => (on ? dateBase + now : real.dateNow());

  const addTimer = (fn, ms, args, repeat) => {
    const delay = Math.max(0, +ms || 0);
    timers.set(nextId, { fn, at: now + delay, every: Math.max(1, delay), args, repeat });
    return nextId++;
  };
  window.setTimeout = (fn, ms, ...args) =>
    on && typeof fn === 'function' ? addTimer(fn, ms, args, false) : real.setTimeout(fn, ms, ...args);
  window.setInterval = (fn, ms, ...args) =>
    on && typeof fn === 'function' ? addTimer(fn, ms, args, true) : real.setInterval(fn, ms, ...args);
  window.clearTimeout = window.clearInterval = (id) => {
    timers.delete(id);
    real.clearTimeout(id);
  };

  const safely = (fn, ...args) => {
    try {
      fn(...args);
    } catch (e) {
      console.error(e);
    }
  };

  function runTimers() {
    for (let guard = 0; guard < 2000; guard++) {
      let due = null;
      for (const entry of timers) if (entry[1].at <= now && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) return;
      const [id, t] = due;
      if (t.repeat) t.at += t.every;
      else timers.delete(id);
      safely(t.fn, ...t.args);
    }
  }

  // CSS transitions/animations and Web Animations run on the compositor's real clock: pause them and drive currentTime.
  function syncAnimations() {
    for (const a of document.getAnimations()) {
      const rate = a.playbackRate || 1;
      if (a.playState === 'running') {
        animStart.set(a, now - (a.currentTime ?? 0) / rate);
        a.pause();
      }
      if (!animStart.has(a) || a.playState !== 'paused') continue;
      const t = (now - animStart.get(a)) * rate;
      const end = a.effect?.getComputedTiming().endTime ?? Infinity;
      if (end !== Infinity && t >= end) a.finish(); // fires transitionend/animationend like a real run
      else a.currentTime = t;
    }
  }

  async function syncVideos(dt) {
    const seeks = [];
    for (const v of document.querySelectorAll('video')) {
      if (!v.paused) {
        playingVideos.add(v);
        v.pause();
      }
      if (!playingVideos.has(v) || !v.duration || v.readyState < 2) continue;
      const box = v.getBoundingClientRect();
      if (box.bottom < 0 || box.top > innerHeight || box.width === 0) continue; // off-screen: nothing to show
      let t = v.currentTime + dt / 1000;
      if (t >= v.duration) t = v.loop ? t % v.duration : v.duration;
      v.currentTime = t;
      seeks.push(new Promise((r) => {
        v.addEventListener('seeked', r, { once: true });
        real.setTimeout(r, 120);
      }));
    }
    await Promise.all(seeks);
  }

  window.__vt = {
    start() {
      if (on) return;
      now = real.now();
      dateBase = real.dateNow() - now;
      on = true;
    },
    // scroll: { from, to, p } with to = number | 'max' (re-read every frame so late-loading content is reached)
    async step(dt, scroll) {
      now += dt;
      if (scroll) {
        const el = window.__sc;
        const to = scroll.to === 'max' ? el.scrollHeight - el.clientHeight : scroll.to;
        el.scrollTop = scroll.from + (to - scroll.from) * scroll.p;
      }
      runTimers();
      const callbacks = frameCallbacks;
      frameCallbacks = new Map();
      for (const cb of callbacks.values()) safely(cb, now);
      syncAnimations();
      await syncVideos(dt);
      await new Promise((r) => real.setTimeout(r, 0)); // let scroll events / observers fire before the shot
    },
    stop() {
      if (!on) return;
      on = false;
      for (const cb of frameCallbacks.values()) real.raf(cb);
      frameCallbacks.clear();
      for (const t of timers.values()) (t.repeat ? real.setInterval : real.setTimeout)(t.fn, Math.max(0, t.at - now), ...t.args);
      timers.clear();
      for (const a of document.getAnimations()) if (animStart.has(a) && a.playState === 'paused') a.play();
      for (const v of playingVideos) v.play().catch(() => {});
    },
  };
})();
