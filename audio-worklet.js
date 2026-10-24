/*
 * Runs on the audio rendering thread (never on the UI thread).
 * - Posts the peak level ~every 10 ms (for calibration and the level meter).
 * - When armed, detects a sharp transient: peak >= threshold AND clearly above
 *   the recent background level. Then disarms itself and holds a lockout so a
 *   single shot cannot fire twice.
 */
class DDDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.thr = 0.05;
    this.ratio = 2.5;
    this.armed = false;
    this.base = 0.001;       // slow background RMS estimate
    this.lock = 0;           // samples of lockout remaining
    this.blocks = 0;
    this.accPeak = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (typeof m.thr === 'number') this.thr = m.thr;
      if (typeof m.ratio === 'number') this.ratio = m.ratio;
      if (typeof m.armed === 'boolean') {
        this.armed = m.armed;
        if (m.armed) this.lock = Math.max(this.lock, sampleRate * 0.25);
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch || !ch.length) return true;
    const n = ch.length;
    let peak = 0, pi = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      const v = ch[i];
      const a = v < 0 ? -v : v;
      sum += v * v;
      if (a > peak) { peak = a; pi = i; }
    }
    const rms = Math.sqrt(sum / n);
    if (this.lock > 0) this.lock -= n;

    if (this.armed && this.lock <= 0 && peak >= this.thr && peak >= this.ratio * this.base) {
      this.armed = false;
      this.lock = sampleRate * 1.5;
      this.port.postMessage({ type: 'trigger', t: currentTime + pi / sampleRate, peak: peak });
    }

    // Background estimate: follows quiet levels, rises only slowly on loud ones.
    const r = Math.min(rms, this.base * 1.5 + 1e-6);
    this.base += (r - this.base) * 0.02;

    if (peak > this.accPeak) this.accPeak = peak;
    if (++this.blocks >= 4) {
      this.port.postMessage({ type: 'level', peak: this.accPeak, t: currentTime });
      this.blocks = 0;
      this.accPeak = 0;
    }
    return true;
  }
}
registerProcessor('dd-detector', DDDetector);
