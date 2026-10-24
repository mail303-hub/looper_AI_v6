/* Pose estimation overlay (MediaPipe Pose Landmarker, ready-made model, no training).
 * Loaded lazily: nothing is downloaded until the switch in Settings is turned on.
 * Draws shoulders, elbows, wrists and hips over the live camera view.
 * Later this module will feed the AI_trig trigger source (full draw / release detection). */
(function () {
  'use strict';
  const VER = '0.10.14';
  const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VER + '/wasm';
  const LIB = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VER + '/vision_bundle.mjs';
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
  // MediaPipe landmark indexes: 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips
  const POINTS = [11, 12, 13, 14, 15, 16, 23, 24];
  const LINES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];
  const INTERVAL_MS = 66;   // about 15 detections per second, enough for an overlay and cheap on phones

  let landmarker = null, loading = null, failed = false;
  let video = null, canvas = null, onStatus = null;
  let running = false, timer = 0, lastVideoTime = -1, token = 0;
  let lastResult = null;    // latest landmarks (normalised), for the future AI_trig logic

  function status(t) { try { if (onStatus) onStatus(t); } catch (e) { /* ignore */ } }

  async function load() {
    if (landmarker) return landmarker;
    if (loading) return loading;
    loading = (async () => {
      status('Loading pose model…');
      const mod = await import(LIB);
      const fileset = await mod.FilesetResolver.forVisionTasks(WASM);
      const make = (delegate) => mod.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1
      });
      try { landmarker = await make('GPU'); }
      catch (e) { landmarker = await make('CPU'); }
      return landmarker;
    })();
    try { return await loading; }
    catch (e) { failed = true; throw e; }
    finally { loading = null; }
  }

  // video is object-fit:contain -> find the rectangle the picture really occupies
  function videoRect() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const vw = video.videoWidth || W, vh = video.videoHeight || H;
    const s = Math.min(W / vw, H / vh);
    const w = vw * s, h = vh * s;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    return dpr;
  }

  function clear() {
    if (!canvas) return;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
  }

  function draw(lm) {
    const dpr = sizeCanvas();
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (!lm) return;
    const r = videoRect();
    // the front camera preview is not mirrored by this app, so landmarks map 1:1
    const P = (i) => ({ x: r.x + lm[i].x * r.w, y: r.y + lm[i].y * r.h, v: lm[i].visibility === undefined ? 1 : lm[i].visibility });
    g.lineWidth = 3; g.lineCap = 'round';
    g.strokeStyle = 'rgba(63,185,80,0.95)';
    LINES.forEach((l) => {
      const a = P(l[0]), b = P(l[1]);
      if (a.v < 0.4 || b.v < 0.4) return;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    });
    g.fillStyle = 'rgba(255,214,10,0.95)';
    POINTS.forEach((i) => {
      const p = P(i);
      if (p.v < 0.4) return;
      g.beginPath(); g.arc(p.x, p.y, 5, 0, Math.PI * 2); g.fill();
    });
  }


  // ---- rule-based draw / release detector (no training) -----------------------
  // All distances are divided by the shoulder width, so they do not depend on camera distance.
  const CFG = {
    anchorDist: 0.65,   // draw wrist this close to the mouth (in shoulder widths) = anchored
    drawDist: 1.30,     // draw wrist closer than this + bow arm straight = drawing started
    bowAngle: 145,      // bow arm elbow angle (deg) at or above = straight arm
    holdMs: 400,        // pose must be steady this long = FULL_DRAW
    steadySpeed: 0.8,   // shoulder widths / s, below = steady
    releaseSpeed: 2.0,  // draw wrist moving away from the face faster than this = RELEASE
    cooldownMs: 1500,
    lostMs: 600         // anchor lost without a fast move for this long = let-down (no release)
  };
  const det = { state: 'IDLE', since: 0, prevD: null, prevT: 0, vS: 0, side: null, flashUntil: 0, flashType: '', lostSince: 0 };
  let onEvent = null;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function angle(a, b, c) { // angle at b, degrees
    const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (!n) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / n))) * 180 / Math.PI;
  }
  function setState(st, t) { det.state = st; det.since = t; status('AI pose: ' + st); }
  function emit(type, t) {
    det.flashUntil = t + 400; det.flashType = type;
    mark('ai_' + type, t);
    try { if (onEvent) onEvent({ type, t }); } catch (e) { /* ignore */ }
  }

  function detect(lm, t) {
    const vis = (i) => lm[i] && (lm[i].visibility === undefined || lm[i].visibility > 0.4);
    if (![0, 9, 10, 11, 12, 13, 14, 15, 16].every(vis)) {
      if (det.state !== 'IDLE' && t - det.since > CFG.lostMs) setState('IDLE', t);
      det.prevD = null; return;
    }
    const sw = dist(lm[11], lm[12]);
    if (sw < 0.03) return;
    const mouth = { x: (lm[9].x + lm[10].x) / 2, y: (lm[9].y + lm[10].y) / 2 };
    const dL = dist(lm[15], mouth) / sw, dR = dist(lm[16], mouth) / sw;
    // the hand nearer the face is the drawing hand, the other arm holds the bow
    const side = (det.state === 'IDLE' || !det.side) ? (dL <= dR ? 'L' : 'R') : det.side;
    const d = side === 'L' ? dL : dR;
    const bowAng = side === 'L' ? angle(lm[12], lm[14], lm[16]) : angle(lm[11], lm[13], lm[15]);
    let v = 0;
    if (det.prevD !== null && t > det.prevT) v = (d - det.prevD) / ((t - det.prevT) / 1000);
    det.vS = det.vS * 0.5 + v * 0.5;  // light smoothing; positive = hand moves away from the face
    det.prevD = d; det.prevT = t;
    const straight = bowAng >= CFG.bowAngle;

    switch (det.state) {
      case 'IDLE':
        if (t >= det.flashUntil + CFG.cooldownMs - 400 && straight && d < CFG.drawDist) { det.side = side; setState('DRAW', t); }
        break;
      case 'DRAW':
        if (!straight || d > CFG.drawDist + 0.3) { setState('IDLE', t); det.side = null; }
        else if (d < CFG.anchorDist && Math.abs(det.vS) < CFG.steadySpeed) {
          if (t - det.since >= CFG.holdMs) { setState('FULL_DRAW', t); emit('full_draw', t); det.lostSince = 0; }
        } else det.since = t; // not anchored/steady yet: restart the hold timer
        break;
      case 'FULL_DRAW':
        if (det.vS > CFG.releaseSpeed && d > CFG.anchorDist * 0.8) { emit('release', t); setState('IDLE', t); det.side = null; }
        else if (d > CFG.anchorDist + 0.15 || !straight) {
          if (!det.lostSince) det.lostSince = t;
          if (t - det.lostSince > CFG.lostMs) { setState('IDLE', t); det.side = null; } // let-down
        } else det.lostSince = 0;
        break;
    }
  }

  function drawState(g) {
    if (det.state === 'IDLE' && performance.now() > det.flashUntil) return;
    const flash = performance.now() < det.flashUntil;
    const rel = flash && det.flashType === 'release';
    g.font = '600 18px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillStyle = rel ? 'rgba(63,185,80,0.95)' : det.state === 'FULL_DRAW' || det.flashType === 'full_draw' && flash ? 'rgba(255,214,10,0.95)' : 'rgba(200,200,200,0.9)';
    g.fillText(rel ? 'RELEASE' : det.state === 'IDLE' ? '' : det.state.replace('_', ' '), canvas.clientWidth / 2, canvas.clientHeight - 110);
  }

  // ---- pose log (for tuning the thresholds / later training) -----------------
  // Frames hold the 11 useful landmarks; labels hold the reference signals
  // (mic / BT trigger = true release time) and the detector's own events.
  const LOG_IDX = [0, 9, 10, 11, 12, 13, 14, 15, 16, 23, 24];
  const LOG_MAX = 20000;
  const log = { on: false, frames: [], marks: [], t0: 0 };
  function setLogging(on) {
    log.on = !!on;
    if (log.on && !log.frames.length) log.t0 = performance.now();
  }
  function clearLog() { log.frames = []; log.marks = []; log.t0 = performance.now(); }
  function mark(label, t) {
    if (!log.on) return;
    log.marks.push({ t: Math.round((t === undefined ? performance.now() : t) - log.t0), label });
  }
  function logFrame(lm, t) {
    if (!log.on) return;
    if (log.frames.length >= LOG_MAX) return;
    log.frames.push({ t: Math.round(t - log.t0), p: LOG_IDX.map((i) => lm ? [+lm[i].x.toFixed(4), +lm[i].y.toFixed(4), +(lm[i].visibility === undefined ? 1 : lm[i].visibility).toFixed(2)] : null) });
  }
  function exportLog() {
    return JSON.stringify({ version: 1, indexes: LOG_IDX, config: CFG, frames: log.frames, marks: log.marks }, null, 0);
  }
  function logInfo() { return log.frames.length + ' frames, ' + log.marks.length + ' marks'; }

  function tick(my) {
    if (!running || my !== token) return;
    try {
      if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const res = landmarker.detectForVideo(video, performance.now());
        lastResult = res && res.landmarks && res.landmarks[0] ? res.landmarks[0] : null;
        draw(lastResult);
        const now = performance.now();
        if (lastResult) detect(lastResult, now);
        logFrame(lastResult, now);
        { const g = canvas.getContext('2d'); g.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0); drawState(g); }
      }
    } catch (e) { status('Pose error: ' + (e && e.message)); }
    timer = setTimeout(() => tick(my), INTERVAL_MS);
  }

  async function start(videoEl, canvasEl, statusCb) {
    video = videoEl; canvas = canvasEl; onStatus = statusCb;
    if (running) return;
    running = true;
    const my = ++token;
    canvas.classList.remove('hidden');
    try {
      await load();
      if (!running || my !== token) return;
      status('Pose estimation on');
      tick(my);
    } catch (e) {
      running = false;
      canvas.classList.add('hidden');
      status('Pose model could not be loaded (internet needed the first time): ' + (e && e.message));
    }
  }

  function stop() {
    running = false; token++;
    clearTimeout(timer); timer = 0;
    lastVideoTime = -1; lastResult = null;
    det.state = 'IDLE'; det.side = null; det.prevD = null; det.vS = 0;
    clear();
    if (canvas) canvas.classList.add('hidden');
    status('Pose estimation off');
  }

  self.DDPose = {
    start, stop, isRunning: () => running, last: () => lastResult,
    onEvent: (fn) => { onEvent = fn; }, config: CFG, state: () => det.state,
    setLogging, clearLog, mark, exportLog, logInfo,
    feed: (lm, t) => detect(lm, t)   // replay a recorded log / unit tests
  };
})();
