/* MOT trigger: motion detector inside a circle placed on the live view.
 * No pose model, no markers: every video frame the circle area is compared with the frame about 50 ms
 * earlier (frame-rate independent). A trigger is a sudden jump of that change after a calm moment.
 * Change value = mean brightness difference inside the circle, in % of full scale (0..100). */
(function () {
  'use strict';
  const N = 32;              // the circle area is reduced to N x N pixels
  const REF_MS = 50;         // compare with the frame this long ago
  const CALM_FROM = 600;     // baseline window: from 600 ms ... to 150 ms before now
  const CALM_TO = 150;
  const LOCKOUT_MS = 1500;
  const CALM_FACTOR = 0.4;   // the baseline must be below this share of the threshold ("calm before the burst")

  const region = { cx: 0.5, cy: 0.5, r: 0.12, set: false };   // cx, cy: share of the video picture; r: share of its shorter side
  const cfg = { thr: 12 };                                     // change threshold (% within ~50 ms)
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
    while (frames.length && t - frames[0].t > 1000) frames.shift();
    let ref = null;
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i].t <= t - REF_MS) { ref = frames[i]; break; }
    if (!ref) return false;
    let sum = 0;
    for (let i = 0; i < gray.length; i++) if (mask[i]) sum += Math.abs(gray[i] - ref.g[i]);
    const v = sum / maskCount / 255 * 100;
    cur = v; if (v > peak) peak = v;
    vals.push({ t, v });
    while (vals.length && t - vals[0].t > 1500) vals.shift();
    try { if (onLevel) onLevel(v, peak); } catch (e) { /* ignore */ }
    if (t - lastTrig < LOCKOUT_MS || v <= cfg.thr) return false;
    let s = 0, n = 0;
    for (let i = 0; i < vals.length; i++) { const a = t - vals[i].t; if (a <= CALM_FROM && a >= CALM_TO) { s += vals[i].v; n++; } }
    if (n < 5) return false;                     // not enough history yet
    if (s / n >= cfg.thr * CALM_FACTOR) return false;   // it was not calm before
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
