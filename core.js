/*
 * Pure logic shared by the app and the tests: threshold maths, clip selection.
 */
(function (root) {
  'use strict';

  const MIN_THR = 0.003;  // about -50 dBFS
  const MAX_THR = 0.95;   // about -0.45 dBFS (loud shots clip at 0 dBFS)

  function toDb(x) { return 20 * Math.log10(Math.max(x, 1e-6)); }
  function fromDb(db) { return Math.pow(10, db / 20); }
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
    return s[i];
  }

  /**
   * Start threshold: above background noise, below the representative shots.
   * @param {number} noisePeak  high percentile of background peak level (0..1)
   * @param {number[]} shotPeaks  peak level of each calibration shot (0..1)
   */
  function computeThreshold(noisePeak, shotPeaks) {
    const noise = Math.max(noisePeak, 0.0015);
    const weakest = Math.min.apply(null, shotPeaks);
    // geometric mean between noise and the weakest shot ...
    let thr = Math.sqrt(noise * weakest);
    // ... but always clearly above noise and clearly below the weakest shot.
    const lo = noise * 2.0;
    const hi = weakest * 0.7;
    if (lo <= hi) thr = clamp(thr, lo, hi);
    else thr = hi; // shots barely above noise: stay below the shots
    return clamp(thr, MIN_THR, MAX_THR);
  }

  /**
   * Choose the encoded frames that make up the event clip.
   * ring: [{t:ms, key:bool, data}] increasing t, first element is a keyframe.
   * Returns null if nothing usable.
   */
  function selectClip(ring, T, preMs, postMs) {
    if (!ring.length) return null;
    const start = T - preMs;
    const end = T + postMs;
    let ki = -1;
    for (let i = 0; i < ring.length; i++) {
      if (ring[i].key && ring[i].t <= start) ki = i;
    }
    if (ki < 0) {
      for (let i = 0; i < ring.length; i++) if (ring[i].key) { ki = i; break; }
    }
    if (ki < 0) return null;
    const samples = [];
    for (let i = ki; i < ring.length; i++) {
      if (ring[i].t >= end) break;
      samples.push(ring[i]);
    }
    if (!samples.length) return null;

    // typical frame interval
    const diffs = [];
    for (let i = 1; i < samples.length; i++) diffs.push(samples[i].t - samples[i - 1].t);
    const frameMs = diffs.length ? percentile(diffs, 0.5) : 33.333;

    const firstT = samples[0].t;
    const lastT = samples[samples.length - 1].t;
    const visStart = Math.max(start, firstT);
    const visEnd = Math.min(end, lastT + frameMs);
    const editStartMs = Math.max(0, visStart - firstT);
    const editDurMs = Math.max(frameMs, visEnd - visStart);
    let frames = 0;
    for (const s of samples) if (s.t >= visStart && s.t < visEnd) frames++;

    return { samples, frameMs, editStartMs, editDurMs, frames, clipStart: visStart, clipEnd: visEnd };
  }

  const api = { toDb, fromDb, clamp, percentile, computeThreshold, selectClip, MIN_THR, MAX_THR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DDCore = api;
})(typeof self !== 'undefined' ? self : this);
