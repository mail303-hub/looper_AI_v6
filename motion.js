/* MOT trigger: motion detector inside a circle placed on the live view (no pose model, no markers).
 * Per video frame the circle area (N x N grey) is compared: the sum of the newest 2 frames against the sum
 * of the 2 frames before them. Change value = % of the circle AREA whose pixels changed by more than PIX.
 * Trigger = that value jumps above the threshold while the earlier level was clearly lower. */
(function () {
  'use strict';
  const N = 32;              // the circle area is reduced to N x N pixels
  const PIX = 20;            // a pixel counts as changed when its brightness differs by more than this (0..255)
  const CALM_FROM = 600;     // baseline window: from 600 ms ... to 150 ms before now
  const CALM_TO = 150;
  const LOCKOUT_MS = 1500;
  const CALM_FACTOR = 0.5;   // the earlier level must be below this share of the current change (a sudden jump)

  const region = { cx: 0.5, cy: 0.5, r: 0.12, set: false };   // cx, cy: share of the video picture; r: share of its shorter side
  const cfg = { thr: 12 };                                     // threshold: % of the circle area that changed
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
  function process(gray, t) {
    frames.push({ t, g: gray });
    while (frames.length > 8) frames.shift();
    const L = frames.length;
    if (L < 4) return false;
    // newest 2 frames (summed) against the 2 frames just before them (summed)
    const f0 = frames[L - 1].g, f1 = frames[L - 2].g, f2 = frames[L - 3].g, f3 = frames[L - 4].g;
    let cnt = 0;
    for (let i = 0; i < gray.length; i++) {
      if (!mask[i]) continue;
      const d = Math.abs((f0[i] + f1[i]) - (f2[i] + f3[i])) / 2;
      if (d > PIX) cnt++;
    }
    const v = cnt / maskCount * 100;          // % of the circle area that changed
    cur = v; if (v > peak) peak = v;
    vals.push({ t, v });
    while (vals.length && t - vals[0].t > 1500) vals.shift();
    try { if (onLevel) onLevel(v, peak); } catch (e) { /* ignore */ }
    if (t - lastTrig < LOCKOUT_MS || v <= cfg.thr) return false;
    let s = 0, n = 0;
    for (let i = 0; i < vals.length; i++) { const a = t - vals[i].t; if (a <= CALM_FROM && a >= CALM_TO) { s += vals[i].v; n++; } }
    if (n < 4) return false;                     // not enough history yet
    if (s / n >= v * CALM_FACTOR) return false;  // the level must have jumped (before it was clearly lower)
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
