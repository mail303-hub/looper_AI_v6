/* MOT trigger: scene-shift detector inside a circle placed on the live view (no pose model, no markers).
 * Per video frame the circle area (N x N grey) is split into blocks; each block of the newest 2 frames (averaged)
 * is matched against the 2 frames before (averaged), with the block mean removed, so brightness/exposure changes
 * do not count. Value = % of the circle area that moves fast SIDEWAYS (vertical motion is ignored).
 * Trigger = that value jumps above the threshold while the earlier level was clearly lower. Left or right does not matter. */
(function () {
  'use strict';
  const N = 48;              // the circle area is reduced to N x N pixels
  const BS = 6;              // block size in pixels (N x N picture -> 8 x 8 blocks)
  const RX = 16, RY = 10;     // search range of the block matching: horizontal / vertical, px
  const MINSHIFT = 3;        // a block counts when it is matched at least this far sideways (px of N = share of the circle diameter) per ~2 frames
  const T0 = 0.35;           // a block counts as changed when its normalised difference is above this
  const FLOOR = 4;           // minimum texture (grey levels) used for normalising, so flat noisy blocks are not amplified
  const CALM_FROM = 600;     // baseline window: from 600 ms ... to 150 ms before now
  const CALM_TO = 150;
  const LOCKOUT_MS = 1500;
  const CALM_FACTOR = 0.5;   // the earlier level must be below this share of the current change (a sudden jump)

  const region = { cx: 0.5, cy: 0.5, r: 0.12, set: false };   // cx, cy: share of the video picture; r: share of its shorter side
  const cfg = { thr: 12, ang: 35 };   // thr: % of circle area moving; ang: allowed tilt of the motion from horizontal, degrees                                     // threshold: % of the circle area that changed
  let video = null, canvas = null, g2 = null;
  let running = false, token = 0, rvfc = 0, timer = 0;
  let frames = [], vals = [];
  let cur = 0, peak = 0, lastTrig = -1e9;
  let onTrigger = null, onLevel = null;
  const mask = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const dx = x + 0.5 - N / 2, dy = y + 0.5 - N / 2; mask[y * N + x] = dx * dx + dy * dy <= (N / 2) * (N / 2) ? 1 : 0; }
  let maskCount = 0; for (let i = 0; i < mask.length; i++) maskCount += mask[i];

  function reset() { frames = []; vals = []; cur = 0; }

  function setRegion(cx, cy, r) {
    region.cx = Math.min(1, Math.max(0, cx)); region.cy = Math.min(1, Math.max(0, cy));
    if (r !== undefined) region.r = Math.min(0.5, Math.max(0.02, r));
    region.set = true; reset();
  }
  function clearRegion() { region.set = false; reset(); }

  // one frame (grayscale N*N) -> change value; returns true when this frame is a trigger
  // scene shift measure: per block, brightness-independent (block mean removed) matching between the
  // newest 2 frames (averaged) and the 2 frames before (averaged). A block "moves" when it changed and
  // it is found shifted sideways by >= MINSHIFT px (and mostly horizontally).
  function process(gray, t) {
    frames.push({ t, g: gray });
    while (frames.length > 8) frames.shift();
    const L = frames.length;
    if (L < 4) return false;
    const A = new Float32Array(N * N), B = new Float32Array(N * N);
    for (let i = 0; i < A.length; i++) {
      A[i] = (frames[L - 1].g[i] + frames[L - 2].g[i]) / 2;
      B[i] = (frames[L - 3].g[i] + frames[L - 4].g[i]) / 2;
    }
    // normalised copies per block position are computed on the fly: (value - block mean) / max(block mean abs deviation, FLOOR)
    const norm = (P, ox, oy) => {
      const o = new Float32Array(BS * BS); let m = 0;
      for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) m += P[(oy + y) * N + ox + x];
      m /= BS * BS;
      let d = 0;
      for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) { const q = P[(oy + y) * N + ox + x] - m; o[y * BS + x] = q; d += Math.abs(q); }
      const sc = 1 / Math.max(d / (BS * BS), FLOOR);
      for (let i = 0; i < o.length; i++) o[i] *= sc;
      return o;
    };
    const diff = (p, q) => { let s = 0; for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]); return s / p.length; };
    const cacheB = new Map();
    const normB = (x, y) => { const k = y * N + x; let r = cacheB.get(k); if (!r) { r = norm(B, x, y); cacheB.set(k, r); } return r; };
    let total = 0, moving = 0;
    for (let by = 0; by + BS <= N; by += BS) for (let bx = 0; bx + BS <= N; bx += BS) {
      const cx = bx + BS / 2 - N / 2, cy = by + BS / 2 - N / 2;
      if (cx * cx + cy * cy > (N / 2 - BS / 2) * (N / 2 - BS / 2)) continue;   // block centre must lie inside the circle
      total++;
      const a = norm(A, bx, by);
      const m0 = diff(a, normB(bx, by));
      if (m0 < T0) continue;                                  // nothing changed in this block
      const TANG = Math.tan(Math.min(85, Math.max(5, cfg.ang)) * Math.PI / 180);
      let best = m0, bdx = 0, bdy = 0, bestV = m0;
      for (let dy = -RY; dy <= RY; dy++) for (let dx = -RX; dx <= RX; dx++) {
        if (!dx && !dy) continue;
        if (bx + dx < 0 || by + dy < 0 || bx + dx + BS > N || by + dy + BS > N) continue;
        const e = diff(a, normB(bx + dx, by + dy));
        if (e < best) { best = e; bdx = dx; bdy = dy; }
        if (dx === 0 && e < bestV) bestV = e;      // best purely vertical match
      }
      // only SIDEWAYS motion counts: clearly matched, shifted sideways by >= MINSHIFT, and within the allowed tilt from horizontal (cfg.ang)
      if (best <= m0 * 0.5 && Math.abs(bdx) >= MINSHIFT && Math.abs(bdy) <= Math.abs(bdx) * TANG && bestV > best * 1.3) moving++;
    }
    const v = total ? moving / total * 100 : 0;                // % of the circle area that moves
    cur = v; if (v > peak) peak = v;
    vals.push({ t, v });
    while (vals.length && t - vals[0].t > 1500) vals.shift();
    try { if (onLevel) onLevel(v, peak); } catch (e) { /* ignore */ }
    if (t - lastTrig < LOCKOUT_MS || v <= cfg.thr) return false;
    let s = 0, n = 0;
    for (let i = 0; i < vals.length; i++) { const a = t - vals[i].t; if (a <= CALM_FROM && a >= CALM_TO) { s += vals[i].v; n++; } }
    if (n < 4) return false;
    if (s / n >= v * CALM_FACTOR) return false;
    lastTrig = t;
    return true;
  }

  function grab(t) {
    if (!running || !region.set || !video || video.readyState < 2 || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const rpx = region.r * Math.min(vw, vh);
    try {
      g2.drawImage(video, region.cx * vw - rpx, region.cy * vh - rpx, rpx * 2, rpx * 2, 0, 0, N, N);
      const d = g2.getImageData(0, 0, N, N).data;
      const gray = new Uint8Array(N * N);
      for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
      if (process(gray, t) && onTrigger) onTrigger(t);
    } catch (e) { /* frame not readable: skip */ }
  }

  function loop(my) {
    if (!running || my !== token) return;
    if (video.requestVideoFrameCallback) {
      rvfc = video.requestVideoFrameCallback(() => { grab(performance.now()); loop(my); });
    } else {
      timer = setTimeout(() => { grab(performance.now()); loop(my); }, 33);
    }
  }

  function start(videoEl) {
    video = videoEl;
    if (running) return;
    if (!canvas) { canvas = document.createElement('canvas'); canvas.width = N; canvas.height = N; g2 = canvas.getContext('2d', { willReadFrequently: true }); }
    running = true; reset();
    loop(++token);
  }
  function stop() {
    running = false; token++;
    try { if (video && rvfc && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(rvfc); } catch (e) { /* ignore */ }
    clearTimeout(timer); timer = 0; rvfc = 0;
    reset();
  }

  self.DDMotion = {
    start, stop, isRunning: () => running,
    setRegion, clearRegion, region, config: cfg,
    onTrigger: (fn) => { onTrigger = fn; }, onLevel: (fn) => { onLevel = fn; },
    level: () => cur, peak: () => peak, resetPeak: () => { peak = 0; },
    process   // tests
  };
})();
