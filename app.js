/*
 * DD Archery Looper v6 (PWA)
 *
 * Camera frames -> WebCodecs H.264 encoder -> in-memory ring buffer of encoded frames.
 * Audio -> AudioWorklet (audio thread) detects a sharp sound -> trigger time T.
 * After the post-trigger part of the clip has been captured, frames from
 * T-before .. T+after (before + after = clip length L, 0.5..5 s, default 2 s,
 * split 50/50 unless changed) are packed into an MP4 (own muxer, edit list for
 * exact trimming) and looped in a <video>.
 * AUTO MODE: signals are also accepted while a clip is playing; the next
 * signal replaces the playing clip with the new one.
 * Trigger input: MIC (AudioWorklet), BT (Web Bluetooth "MOT") or PHONE (a second phone running
 * the MOTION SENDER screen publishes "MOT" over MQTT/WSS, see phone.js).
 *
 * Nothing is written to disk while rolling: the ring buffer lives in memory and
 * is trimmed continuously, so storage cannot grow.
 */
(function () {
  'use strict';

  const Core = self.DDCore;
  const Mp4 = self.DDMp4;
  const Phone = self.DDPhone;
  const Pose = self.DDPose;
  const $ = (id) => document.getElementById(id);

  // ---- constants -----------------------------------------------------------
  const RING_MARGIN_MS = 1500;  // ring keeps clip length + this much extra
  const FPS_DEFAULT = 30;       // filming speed: 30 or 60 fps (setting)
  const PX_PER_FRAME = 8;       // swipe distance per skipped frame
  const ZOOM_MAX = 8;
  const BUF_MIN = 0.5, BUF_MAX = 5;
  const GRID_MIN = 30, GRID_MAX = 200;
  const SLOMO_MIN = 1, SLOMO_MAX = 30, SLOMO_DEFAULT = 7;
  const LS_THR = 'dd_threshold';
  const LS_OFF = 'dd_sync_offset';
  const LS_PREFS = 'dd_prefs';
  const LS_ZOOM = 'dd_zoom';
  const BT_DEFAULT_NAME = 'xiao_mg24_1';
  const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';  // Nordic UART
  // services tried by default (comma separated list; the first ones found on the device are used)
  // first: the service of the Seeed XIAO MG24 / Silicon Labs Arduino BLE examples (notify characteristic 61a885a4-...)
  // fixed (not editable): a wrong value would make the BT module impossible to connect
  const BT_SERVICES = 'de8a5aac-a99b-c315-0c80-60d4cbb51224, ' + NUS_SERVICE + ', 4880c12c-fdcb-4077-8920-a450d7f9b907, ffe0, 49535343-fe7d-4ae5-8fa9-9fafd205e455, fff0';
  const BT_LOCKOUT_MS = 1500;   // one signal per shot, like the microphone (BT and PHONE)
  const MOTION_MIN = 5, MOTION_MAX = 100, MOTION_DEFAULT = 15;  // MOTION SENDER threshold, m/s²
  const GEAR_HOLD_MS = 800;     // sender lock screen: hold the gear this long to open the settings
  const SND_AUTOLOCK_MS = 20000; // sender settings left open without a touch lock again
  const EDGE_ZONE = 0.25;       // left/right quarter of the screen = frame step, middle half = play/pause
  const GRID_COLORS = {
    black: [0, 0, 0], white: [255, 255, 255], red: [255, 40, 40], green: [0, 220, 0], blue: [30, 100, 255]
  };
  const AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };

  // ---- state ---------------------------------------------------------------
  const S = {
    gen: 0,               // incremented on every start/stop, invalidates stale async work
    vgen: 0,              // incremented whenever the video pipeline restarts (start/stop/camera switch)
    running: false,
    starting: false,
    switching: false,
    capturing: false,     // an event is being recorded/built (ring buffer must not be trimmed)
    mode: 'idle',         // idle | live | pending | building | playback
    stream: null,
    vTrack: null,
    live: $('live'),
    ctx: null, srcNode: null, node: null, gainNode: null,
    armedPosted: false,
    encoder: null, encInit: null, encW: 0, encH: 0, avcC: null,
    ring: [],
    needKey: true, sinceKey: 0, lastTs: 0,
    reader: null,
    wake: null,
    thr: 0.944,           // default = least sensitive (about -0.5 dBFS): only very loud shots
    offsetMs: 0,
    prefs: { buf: 2, split: 0.5, cam: null, zoomOn: false, gridOn: false, gridSize: 100, gridInt: 5, gridColor: 'white', auto: false, orient: 'landscape', input: 'mic', slomoFps: SLOMO_DEFAULT, btName: BT_DEFAULT_NAME, fps: FPS_DEFAULT,
      room: '', mqttUrl: Phone.DEFAULT_URL, sndRoom: '', motionThr: MOTION_DEFAULT, sensorThr: MOTION_DEFAULT,
      poseOn: false, poseLog: false, aiMode: 'wrist', aiThr: 2.0, aiRef: 'mouth' },
    ai: { lastSig: 0 },   // AI_trig (pose) signal lockout, same role as S.bt / S.ph
    zoom: { s: 1, tx: 0, ty: 0 },
    cams: [], camId: null,
    panelOpen: false,
    calib: null,
    clip: null,
    frameDur: 1 / 30,
    saving: false, sharing: false,
    lastScrubEnd: 0,
    lastName: '', nameSeq: 0,
    // diagnostics
    frames: 0, dropped: 0, fpsT0: 0, fpsN: 0, lastFrameAt: 0, fps: 0,
    meterVal: 0,
    micOk: false,
    micStarting: false,
    slomo: false, slomoTimer: 0, slomoF: 0,
    fpsMax: null, fpsActual: null,   // what the camera reports (null = unknown)
    bt: { dev: null, server: null, state: 'off', battery: null, chars: [], want: false, busy: false, retryTimer: 0, lastSig: 0, bound: null },
    // PHONE trigger (this phone = looper, receives MOT over MQTT)
    ph: { lastPeak: null, client: null, state: 'off', want: false, busy: false, retryTimer: 0, tries: 0, lastSig: 0, lastA: null, lastRxAt: 0, err: '' },
    // MOTION SENDER (this phone = sensor, publishes MOT)
    snd: { active: false, busy: false, client: null, det: null, wake: null, retryTimer: 0, seen: false, noData: false, sent: 0, peak: 0, shotPeak: 0, shotUntil: 0, uiAt: 0, locked: false, lockTimer: 0, flashTimer: 0 },
    timers: []
  };

  const logs = [];
  function log() {
    const msg = Array.prototype.slice.call(arguments).join(' ');
    const line = (performance.now() / 1000).toFixed(3) + ' ' + msg;
    logs.push(line);
    if (logs.length > 400) logs.shift();
    try { console.log('[DD]', msg); } catch (e) { /* ignore */ }
    if (!$('debug-log').classList.contains('hidden')) renderDebug();
  }
  function renderDebug() {
    const el = $('debug-log');
    el.textContent = logs.slice(-300).join('\n');
    el.scrollTop = el.scrollHeight;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const fmt = (n) => String(+n.toFixed(2));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // clip window: buf = total length, split = share of it that lies before the signal
  // (0.5 = trigger in the middle). Seconds before the signal are kept in 0.1 s steps.
  function preSec() { return Core.clamp(Math.round(S.prefs.buf * S.prefs.split * 10) / 10, 0, S.prefs.buf); }
  function preMs() { return Math.round(preSec() * 1000); }
  function postMs() { return Math.round(S.prefs.buf * 1000) - preMs(); }
  function armSpanMs() { return preMs() + 100; }
  function ringKeepMs() { return S.prefs.buf * 1000 + RING_MARGIN_MS; }

  // ---- small UI helpers ----------------------------------------------------
  let toastTimer = 0;
  function toast(text, kind, ms) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 2500);
  }

  function show(id, on) { $(id).classList.toggle('hidden', !on); }

  function setMode(m) {
    S.mode = m;
    const idle = m === 'idle';
    const playback = m === 'playback';
    show('start', idle);
    show('hud-live', !idle && !playback);
    show('hud-play', playback);
    show('topbar', !idle);
    show('playview', playback);
    applyGrid();
    updateStatus();
    applyPose();
  }

  // ---- pose estimation / AI_trig ---------------------------------------------
  function applyPoseConfig() {
    if (!Pose) return;
    const c = Pose.config, p = S.prefs;
    c.mode = p.aiMode;
    c.ref = p.aiRef;
    c.releaseSpeed = p.aiThr;
    c.elbowSpeed = Math.round(p.aiThr * 75) / 100;   // elbow: 75 % of the wrist threshold
    c.interval = p.input === 'ai' ? 33 : 66;          // the release movement is short: sample faster in AI_trig mode
  }

  // pose runs on the live view when the overlay switch or AI_trig is on (also while a clip plays in AUTO MODE)
  function applyPose() {
    if (!Pose) return;
    const ai = S.prefs.input === 'ai';
    const modeOk = S.mode === 'live' || S.mode === 'pending' || (ai && S.mode === 'playback');   // AI_trig also watches while a clip plays
    const want = (S.prefs.poseOn || ai) && modeOk && S.running;
    applyPoseConfig();
    Pose.setOverlay(S.prefs.poseOn && S.mode !== 'playback');
    if (want && !Pose.isRunning()) Pose.start(S.live, $('pose'), (t) => { $('pose-info').textContent = t; updateStatus(); });
    else if (!want && Pose.isRunning()) Pose.stop();
    else if (!want) $('pose-info').textContent = (S.prefs.poseOn || ai) ? 'On (runs on the live view).' : 'Off.';
  }

  function updateStatus() {
    const el = $('status');
    let txt = '', rec = false;
    if (S.mode === 'live') {
      if (S.calib || S.panelOpen) txt = '';
      else if (S.switching) txt = 'SWITCHING CAMERA';
      else if (S.prefs.input === 'bt' && S.bt.state !== 'connected') txt = S.bt.state === 'connecting' ? 'BT CONNECTING' : (S.bt.state === 'lost' ? 'BT RECONNECTING' : 'BT NOT CONNECTED');
      else if (S.prefs.input === 'phone' && S.ph.state !== 'connected') txt = S.ph.state === 'connecting' ? 'PHONE CONNECTING' : (S.ph.state === 'lost' ? 'PHONE RECONNECTING' : 'PHONE NOT CONNECTED');
      else if (S.prefs.input === 'ai' && Pose && !Pose.ready()) txt = Pose.error() ? 'AI MODEL ERROR' : 'AI LOADING';
      else if (S.prefs.input === 'mic' && !S.micOk) txt = 'MIC OFF';
      else if (S.lastFrameAt && performance.now() - S.lastFrameAt > 3000) txt = 'NO CAMERA FRAMES';
      else if (ringSpan() < armSpanMs()) txt = 'WARMING UP';
      else txt = '● LISTENING';
    } else if (S.mode === 'pending') { txt = '● REC'; rec = true; }
    else if (S.mode === 'building') txt = 'PROCESSING';
    el.textContent = txt;
    el.classList.toggle('rec', rec);
    el.style.display = txt ? '' : 'none';
    // AUTO MODE badge shown over the playing clip
    const ab = $('auto-status');
    let at = '', arec = false;
    if (S.mode === 'playback' && S.prefs.auto) { arec = S.capturing; at = arec ? '● REC' : 'AUTO ● LISTENING'; }
    ab.textContent = at;
    ab.classList.toggle('rec', arec);
    ab.style.display = at ? '' : 'none';
    updateTopbar();
  }

  // top centre: input source (MIC / BT / PHONE), the battery value received over BT, the PHONE room code
  function updateTopbar() {
    const bt = S.prefs.input === 'bt';
    const ph = S.prefs.input === 'phone';
    const ai = S.prefs.input === 'ai';
    const aiOk = ai && Pose && Pose.ready();
    const src = $('src-text');
    src.textContent = ai ? (aiOk ? 'AI' : 'AI ✕') : bt ? (S.bt.state === 'connected' ? 'BT' : 'BT ✕') : ph ? (S.ph.state === 'connected' ? 'PHONE' : 'PHONE ✕') : 'MIC';
    src.className = ai ? (aiOk ? 'good' : 'bad') : bt ? (S.bt.state === 'connected' ? 'good' : 'bad') : ph ? (S.ph.state === 'connected' ? 'good' : 'bad') : '';
    $('bat-text').textContent = ai ? (aiOk ? Pose.state().replace('_', ' ') : '') : bt && S.bt.battery !== null ? 'bat ' + S.bt.battery + '%' : ph ? 'ROOM ' + S.prefs.room + (S.ph.lastPeak !== null ? ' · peak ' + S.ph.lastPeak.toFixed(1) : '') : '';
    const hb = $('btn-bt-hud');
    if (hb) show('btn-bt-hud', bt && S.mode === 'live' && S.bt.state !== 'connected' && S.bt.state !== 'connecting');
  }

  // ---- settings storage ----------------------------------------------------
  function loadSettings() {
    try {
      const t = parseFloat(localStorage.getItem(LS_THR));
      if (isFinite(t) && t > 0) S.thr = Core.clamp(t, Core.MIN_THR, Core.MAX_THR);
      const o = parseFloat(localStorage.getItem(LS_OFF));
      if (isFinite(o)) S.offsetMs = Core.clamp(o, -300, 300);
      const raw = localStorage.getItem(LS_PREFS);
      if (raw) {
        const p = JSON.parse(raw);
        const d = S.prefs;
        if (isFinite(p.buf)) d.buf = Core.clamp(Math.round(p.buf * 2) / 2, BUF_MIN, BUF_MAX);
        if (isFinite(p.split)) d.split = Core.clamp(p.split, 0, 1);
        if (typeof p.cam === 'string' && p.cam) d.cam = p.cam;
        d.zoomOn = !!p.zoomOn;
        d.gridOn = !!p.gridOn;
        d.auto = !!p.auto;
        d.orient = p.orient === 'portrait' ? 'portrait' : 'landscape';
        if (isFinite(p.gridSize)) d.gridSize = Core.clamp(Math.round(p.gridSize), GRID_MIN, GRID_MAX);
        if (isFinite(p.gridInt)) d.gridInt = Core.clamp(Math.round(p.gridInt), 1, 10);
        if (GRID_COLORS[p.gridColor]) d.gridColor = p.gridColor;
        if (isFinite(p.slomoFps)) d.slomoFps = Core.clamp(Math.round(p.slomoFps), SLOMO_MIN, SLOMO_MAX);
        if (typeof p.btName === 'string' && p.btName.trim()) d.btName = p.btName.trim().slice(0, 32);
        d.fps = p.fps === 60 ? 60 : 30;
        d.input = p.input === 'bt' && btSupported() ? 'bt' : p.input === 'phone' ? 'phone' : p.input === 'ai' ? 'ai' : 'mic';
        d.poseOn = !!p.poseOn;
        d.poseLog = !!p.poseLog;
        d.aiMode = p.aiMode === 'elbow' || p.aiMode === 'both' ? p.aiMode : 'wrist';
        if (isFinite(p.aiThr)) d.aiThr = Core.clamp(Math.round(p.aiThr * 10) / 10, 0.5, 4);
        d.aiRef = p.aiRef === 'nose' ? 'nose' : 'mouth';
        if (typeof p.room === 'string') d.room = Phone.cleanRoom(p.room);
        if (typeof p.mqttUrl === 'string' && p.mqttUrl.trim()) d.mqttUrl = p.mqttUrl.trim().slice(0, 200);
        if (typeof p.sndRoom === 'string') d.sndRoom = Phone.cleanRoom(p.sndRoom);
        if (isFinite(p.motionThr)) d.motionThr = p.motionThr >= MOTION_MIN && p.motionThr <= MOTION_MAX ? Math.round(p.motionThr * 2) / 2 : MOTION_DEFAULT; // outside the range (older version): back to the default
        if (isFinite(p.sensorThr)) d.sensorThr = p.sensorThr >= MOTION_MIN && p.sensorThr <= MOTION_MAX ? Math.round(p.sensorThr * 2) / 2 : MOTION_DEFAULT;
      }
      if (S.prefs.zoomOn) {
        const z = JSON.parse(localStorage.getItem(LS_ZOOM) || 'null');
        if (z && isFinite(z.s) && isFinite(z.tx) && isFinite(z.ty)) S.zoom = { s: z.s, tx: z.tx, ty: z.ty };
      }
    } catch (e) { /* storage unavailable or corrupt: use defaults */ }
    // every looper phone gets its own random room code once; it stays the same until "New code"
    if (!Phone.validRoom(S.prefs.room)) { S.prefs.room = Phone.randomRoom(); savePrefs(); }
    refreshSettingsUi();
  }

  function savePrefs() {
    try { localStorage.setItem(LS_PREFS, JSON.stringify(S.prefs)); } catch (e) { /* ignore */ }
  }
  function saveZoom() {
    try { localStorage.setItem(LS_ZOOM, JSON.stringify(S.zoom)); } catch (e) { /* ignore */ }
  }

  function meterPct(v) { return Core.clamp((Core.toDb(v) + 60) / 60, 0, 1) * 100; }

  function refreshSettingsUi() {
    const p = S.prefs;
    const db = Core.toDb(S.thr);
    $('thr-text').textContent = db.toFixed(1) + ' dB';
    $('thr-slider').value = String(Core.clamp(db, -60, -0.5));
    $('off-slider').value = String(S.offsetMs);
    $('off-text').textContent = String(Math.round(S.offsetMs));
    $('meter-thr').style.left = meterPct(S.thr) + '%';
    $('buf-slider').value = String(p.buf);
    $('buf-text').textContent = fmt(p.buf) + ' s';
    const pre = preSec();
    $('split-slider').max = String(p.buf);   // max first, then the value
    $('split-slider').value = String(pre);
    $('split-text').textContent = fmt(pre) + ' s before | ' + fmt(Math.round((p.buf - pre) * 10) / 10) + ' s after';
    $('zoom-on').checked = p.zoomOn;
    $('grid-on').checked = p.gridOn;
    $('grid-size').value = String(p.gridSize);
    $('grid-size-text').textContent = p.gridSize + ' px';
    $('grid-int').value = String(p.gridInt);
    $('grid-int-text').textContent = String(p.gridInt);
    Object.keys(GRID_COLORS).forEach((c) => $('gc-' + c).classList.toggle('sel', p.gridColor === c));
    $('auto-on').checked = p.auto;
    $('ori-landscape').classList.toggle('sel', p.orient === 'landscape');
    $('ori-portrait').classList.toggle('sel', p.orient === 'portrait');
    $('slomo-slider').value = String(p.slomoFps);
    $('slomo-text').textContent = p.slomoFps + ' fps';
    $('fps-30').classList.toggle('sel', p.fps === 30);
    $('fps-60').classList.toggle('sel', p.fps === 60);
    $('fps-60').disabled = S.fpsMax !== null && S.fpsMax < 59;
    $('fps-info').textContent = 'Measured: ' + (S.fps ? S.fps.toFixed(0) + ' fps' : '–') + (S.dropped ? ' (dropped ' + S.dropped + ')' : '') + '\nCamera: ' + (S.fpsActual ? Math.round(S.fpsActual) + ' fps now' : 'fps unknown') +
      (S.fpsMax !== null ? ', max ' + Math.round(S.fpsMax) + ' fps' : '') + (S.fpsMax !== null && S.fpsMax < 59 ? ' (60 fps not supported)' : '');
    const bt = p.input === 'bt';
    const ph = p.input === 'phone';
    const ai = p.input === 'ai';
    const notMic = bt || ph || ai;
    $('in-mic').classList.toggle('sel', !notMic);
    $('in-bt').classList.toggle('sel', bt);
    $('in-phone').classList.toggle('sel', ph);
    $('in-ai').classList.toggle('sel', ai);
    $('pose-on').checked = p.poseOn;
    $('pose-log-on').checked = p.poseLog;
    ['wrist', 'elbow', 'both'].forEach((m) => $('ai-m-' + m).classList.toggle('sel', p.aiMode === m));
    ['mouth', 'nose'].forEach((m) => $('ai-r-' + m).classList.toggle('sel', p.aiRef === m));
    $('ai-thr').value = String(p.aiThr);
    $('ai-thr-text').textContent = p.aiThr.toFixed(1);
    if (Pose) { Pose.setLogging(p.poseLog); $('pose-log-info').textContent = p.poseLog ? 'Log: recording, ' + Pose.logInfo() + '.' : 'Log: off (' + Pose.logInfo() + ' kept).'; }
    if (document.activeElement !== $('bt-name')) $('bt-name').value = p.btName;
    $('btn-calib').disabled = notMic;
    $('thr-slider').disabled = notMic;
    $('sec-mic').classList.toggle('off', notMic);
    if (document.activeElement !== $('ph-room')) $('ph-room').value = p.room;
    if (document.activeElement !== $('ph-url')) $('ph-url').value = p.mqttUrl;
    $('ph-sthr').value = String(p.sensorThr);
    $('ph-sthr-text').textContent = p.sensorThr.toFixed(1) + ' m/s²';
    $('btn-ph-connect').textContent = !ph ? 'Use PHONE trigger' : S.ph.want ? 'Disconnect' : 'Connect';
    const lastMot = S.ph.lastRxAt ? '\nLast MOT: ' + new Date(S.ph.lastRxAt).toLocaleTimeString() + (S.ph.lastA !== null ? ' (' + S.ph.lastA.toFixed(1) + ' m/s²)' : '') +
      (S.ph.lastPeak !== null ? '\nLast peak on the sensor: ' + S.ph.lastPeak.toFixed(1) + ' m/s² (threshold ' + p.sensorThr.toFixed(1) + ')' : '') : '';
    $('ph-info').textContent = !ph ? 'Phone trigger off.'
      : ({ off: 'Not connected.', connecting: 'Connecting…', connected: 'Connected, room ' + p.room + '. Waiting for MOT.', lost: 'Connection lost, retrying…' }[S.ph.state] || '') +
        (S.ph.state !== 'connected' && S.ph.err ? '\n' + S.ph.err : '') + lastMot;
    const btn = $('btn-bt-connect');
    btn.disabled = !bt || !btSupported();
    btn.textContent = S.bt.state === 'connected' ? 'Reconnect / choose device' : 'Connect BT';
    $('bt-info').textContent = !btSupported() ? 'Web Bluetooth is not available in this browser.'
      : !bt ? 'BT off (microphone is the trigger).'
      : 'BT ' + ({ off: 'not connected', connecting: 'connecting…', connected: 'connected', lost: 'connection lost, retrying…' }[S.bt.state] || '') +
        (S.bt.battery !== null ? ', bat ' + S.bt.battery + '%' : '');
  }

  function applyThreshold(thr, persist) {
    S.thr = Core.clamp(thr, Core.MIN_THR, Core.MAX_THR);
    if (persist) { try { localStorage.setItem(LS_THR, String(S.thr)); } catch (e) { /* ignore */ } }
    if (S.node) S.node.port.postMessage({ thr: S.thr });
    refreshSettingsUi();
    log('audio threshold', S.thr.toFixed(4), Core.toDb(S.thr).toFixed(1) + ' dB');
  }

  // ---- grid ----------------------------------------------------------------
  function applyGrid() {
    const p = S.prefs;
    const on = p.gridOn && (S.mode === 'playback' || S.panelOpen);
    show('grid', on);
    if (!on) return;
    const c = GRID_COLORS[p.gridColor] || GRID_COLORS.white;
    const col = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (p.gridInt / 10) + ')';
    const g = $('grid');
    g.style.backgroundImage = 'linear-gradient(to right,' + col + ' 1px,transparent 1px),linear-gradient(to bottom,' + col + ' 1px,transparent 1px)';
    g.style.backgroundSize = p.gridSize + 'px ' + p.gridSize + 'px';
    // a grid line passes through the exact screen centre
    g.style.backgroundPosition = Math.round((window.innerWidth || 0) / 2) + 'px ' + Math.round((window.innerHeight || 0) / 2) + 'px';
  }

  // ---- zoom ----------------------------------------------------------------
  function clampZoom() {
    const z = S.zoom;
    z.s = Core.clamp(z.s, 1, ZOOM_MAX);
    const W = window.innerWidth || 0, H = window.innerHeight || 0;
    z.tx = Core.clamp(z.tx, W * (1 - z.s), 0);
    z.ty = Core.clamp(z.ty, H * (1 - z.s), 0);
  }

  function applyZoom() {
    clampZoom();
    const z = S.zoom;
    const active = S.prefs.zoomOn && z.s > 1.001;
    const v = $('play');
    v.style.transformOrigin = '0 0';
    v.style.transform = active ? 'translate(' + z.tx + 'px,' + z.ty + 'px) scale(' + z.s + ')' : '';
    show('btn-zoom-reset', active && S.mode === 'playback');
  }

  function resetZoom() {
    S.zoom = { s: 1, tx: 0, ty: 0 };
    saveZoom();
    applyZoom();
    log('zoom reset');
  }

  // ---- screen orientation --------------------------------------------------
  // Android (Chrome, fullscreen/installed) can lock the orientation. iOS/desktop
  // browsers cannot: there the user simply rotates the device; the layout adapts.
  async function applyOrientation(fromUser) {
    const want = S.prefs.orient;
    try {
      const so = screen.orientation;
      if (so && so.lock) {
        const de = document.documentElement;
        if (fromUser && !document.fullscreenElement && de.requestFullscreen) {
          try { await de.requestFullscreen({ navigationUI: 'hide' }); } catch (e) { /* ignore */ }
        }
        await so.lock(want);
        log('orientation locked:', want);
        return true;
      }
    } catch (e) { log('orientation lock failed:', e && e.message); }
    if (fromUser) toast('This browser cannot lock the screen.\nRotate the phone to ' + want + ' (turn off rotation lock).', null, 4500);
    return false;
  }

  function setOrientation(o) {
    S.prefs.orient = o;
    savePrefs();
    refreshSettingsUi();
    applyOrientation(true);
  }

  // ---- media setup ---------------------------------------------------------
  function explainMediaError(e, what) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return what + ' permission denied.\nAllow camera and microphone for this site in the browser/site settings, then press START.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return what + ' not found on this device.';
    if (n === 'NotReadableError' || n === 'AbortError') return what + ' is busy or cannot be started (is another app using it?).';
    return what + ' error: ' + ((e && (e.message || e.name)) || e);
  }

  // Default camera = front ("user"). A camera chosen in the settings is remembered.
  function fpsTarget() { return S.prefs.fps === 60 ? 60 : 30; }
  function keyEvery() { return Math.round(fpsTarget() / 3); } // keyframe about every 0.33 s

  // remember what the camera really delivers / can deliver
  function noteTrack(vt) {
    let st = {}, caps = null;
    try { st = vt.getSettings ? vt.getSettings() : {}; } catch (e) { /* ignore */ }
    try { caps = vt.getCapabilities ? vt.getCapabilities() : null; } catch (e) { /* ignore */ }
    S.fpsActual = st.frameRate || null;
    S.fpsMax = caps && caps.frameRate && isFinite(caps.frameRate.max) ? caps.frameRate.max : null;
    refreshSettingsUi();
  }

  function videoConstraints(deviceId) {
    const f = fpsTarget();
    const v = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: f, max: f } };
    if (deviceId) v.deviceId = { exact: deviceId };
    else v.facingMode = { ideal: 'user' };
    return v;
  }

  // Phones often offer 60 fps only at some resolutions. For 60 fps first try several resolutions with a
  // hard minimum of 50 fps (the browser then only accepts a mode that really does it), then the normal request.
  const FPS60_SIZES = [[1280, 720], [1920, 1080], [960, 540], [854, 480], [640, 480]];
  function videoAttempts(deviceId) {
    const list = [];
    if (fpsTarget() === 60) {
      FPS60_SIZES.forEach((sz) => {
        const v = { width: { ideal: sz[0] }, height: { ideal: sz[1] }, frameRate: { min: 50, ideal: 60 } };
        if (deviceId) v.deviceId = { exact: deviceId }; else v.facingMode = { ideal: 'user' };
        list.push(v);
      });
    }
    list.push(videoConstraints(deviceId));
    return list;
  }

  async function getVideoStream(deviceId) {
    let lastErr = null;
    for (const v of videoAttempts(deviceId)) {
      try { return await navigator.mediaDevices.getUserMedia({ video: v }); }
      catch (e) { lastErr = e; log('camera mode refused:', JSON.stringify(v.frameRate), e && e.name); }
    }
    throw lastErr;
  }

  async function openMedia(wantAudio) {
    const audio = wantAudio ? AUDIO_CONSTRAINTS : false;
    const attempts = [];
    if (S.prefs.cam) videoAttempts(S.prefs.cam).forEach((v) => attempts.push(v));
    videoAttempts(null).forEach((v) => attempts.push(v));
    attempts.push(true);
    let lastErr = null;
    for (const v of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: v, audio: audio });
      } catch (e) {
        lastErr = e;
        log('getUserMedia failed:', e && e.name, e && e.message);
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'NotReadableError')) break;
      }
    }
    // find out which device is the problem
    let camOk = false, micOk = false;
    try { (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop()); camOk = true; } catch (e) { /* ignore */ }
    if (wantAudio) { try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); micOk = true; } catch (e) { /* ignore */ } } else micOk = true;
    if (!camOk) throw Object.assign(new Error(explainMediaError(lastErr, 'Camera')), { friendly: true });
    if (!micOk) throw Object.assign(new Error(explainMediaError(lastErr, 'Microphone')), { friendly: true });
    throw lastErr;
  }

  async function setupAudio(gen) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !window.AudioWorkletNode) throw Object.assign(new Error('This browser has no AudioWorklet support (update the browser).'), { friendly: true });
    const ctx = S.ctx; // created synchronously in the START tap (iOS needs that)
    if (!ctx) throw new Error('audio context missing');
    try { await ctx.resume(); } catch (e) { log('ctx.resume failed', e); }
    await ctx.audioWorklet.addModule('audio-worklet.js');
    if (S.gen !== gen) return;
    const audioTracks = S.stream.getAudioTracks();
    if (!audioTracks.length) throw Object.assign(new Error('No microphone track available.'), { friendly: true });
    S.srcNode = ctx.createMediaStreamSource(new MediaStream(audioTracks));
    S.node = new AudioWorkletNode(ctx, 'dd-detector', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    S.gainNode = ctx.createGain();
    S.gainNode.gain.value = 0; // keeps the graph pulled without any audible output
    S.srcNode.connect(S.node);
    S.node.connect(S.gainNode);
    S.gainNode.connect(ctx.destination);
    S.node.port.onmessage = onAudioMessage;
    S.node.port.postMessage({ thr: S.thr, armed: false });
    S.armedPosted = false;
    S.micOk = ctx.state === 'running';
    audioTracks[0].addEventListener('ended', () => { S.micOk = false; toast('Microphone lost', 'err', 4000); log('mic track ended'); });
    log('audio ready: sampleRate', ctx.sampleRate, 'state', ctx.state, 'baseLatency', ctx.baseLatency);
  }

  // ---- cameras -------------------------------------------------------------
  async function refreshCameras() {
    let list = [];
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      list = devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || ('Camera ' + (i + 1)) }));
    } catch (e) { log('enumerateDevices failed', e && e.message); }
    S.cams = list;
    if (!S.camId && S.vTrack) {
      const st = S.vTrack.getSettings ? S.vTrack.getSettings() : {};
      const byLabel = list.find((c) => c.label === S.vTrack.label);
      S.camId = st.deviceId || (byLabel && byLabel.id) || null;
    }
    const sel = $('cam-select');
    sel.innerHTML = list.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.label) + '</option>').join('');
    if (S.camId) sel.value = S.camId;
    const multi = list.length > 1 && !S.switching;
    sel.disabled = !multi;
    $('btn-cam-flip').disabled = !multi;
    log('cameras:', list.map((c) => c.label).join(' | '), 'current', S.camId);
  }

  async function switchCamera(id, force) {
    if (!S.running || S.switching || S.mode !== 'live' || (!id && !force) || (id && id === S.camId && !force)) { refreshCameras(); return; }
    const gen = S.gen;
    const prevId = S.camId;
    S.switching = true;
    $('cam-select').disabled = true;
    $('btn-cam-flip').disabled = true;
    updateArming();
    updateStatus();
    log('switching camera ->', id);
    try {
      stopVideoPipeline(true);
      await sleep(250); // some phones need a moment to release the previous camera
      let vs;
      try {
        vs = await getVideoStream(id);
      } catch (e) {
        log('camera switch failed:', e && e.name, e && e.message);
        toast('Camera not available: ' + ((e && e.name) || 'error'), 'err', 3500);
        vs = await getVideoStream(prevId); // go back
        id = prevId;
      }
      if (S.gen !== gen) { vs.getTracks().forEach((t) => t.stop()); return; }
      await attachVideo(vs, gen);
      const st2 = S.vTrack && S.vTrack.getSettings ? S.vTrack.getSettings() : {};
      S.camId = id || st2.deviceId || null;
      if (id) { S.prefs.cam = id; savePrefs(); }
    } catch (e) {
      log('camera restore failed:', e && e.message);
      if (S.gen === gen) await stopAll('Camera could not be started.\nPress START to try again.');
      return;
    } finally {
      S.switching = false;
    }
    if (S.gen !== gen) return;
    await refreshCameras();
    updateArming();
    updateStatus();
  }

  async function attachVideo(vs, gen) {
    const vt = vs.getVideoTracks()[0];
    if (!vt) throw new Error('no camera track');
    const st = vt.getSettings ? vt.getSettings() : {};
    log('camera settings', JSON.stringify({ w: st.width, h: st.height, fps: st.frameRate, facing: st.facingMode, label: vt.label }));
    noteTrack(vt);
    S.stream = new MediaStream([vt].concat(S.stream ? S.stream.getAudioTracks() : []));
    vt.addEventListener('ended', () => {
      if (S.vTrack === vt && S.running && !S.switching) stopAll('Camera was disconnected or taken by another app.\nPress START to try again.');
    });
    S.live.srcObject = new MediaStream([vt]);
    await S.live.play().catch((e) => log('preview play failed', e && e.message));
    if (S.gen !== gen) return;
    startVideoPipeline(vt);
  }

  // ---- video: frame pump + encoder ----------------------------------------
  function stopVideoPipeline(stopTrack) {
    S.vgen++;
    try { if (S.reader) S.reader.cancel(); } catch (e) { /* ignore */ }
    S.reader = null;
    try { if (S.encoder && S.encoder.state !== 'closed') S.encoder.close(); } catch (e) { /* ignore */ }
    S.encoder = null; S.encInit = null; S.avcC = null; S.ring = [];
    S.needKey = true; S.sinceKey = 0; S.lastTs = 0;
    S.frames = 0; S.dropped = 0; S.fpsT0 = 0; S.fpsN = 0; S.lastFrameAt = 0;
    if (stopTrack) {
      try { if (S.vTrack) S.vTrack.stop(); } catch (e) { /* ignore */ }
      S.vTrack = null;
    }
  }

  function startVideoPipeline(vt) {
    const vg = S.vgen;
    S.vTrack = vt;
    if ('MediaStreamTrackProcessor' in window) pumpProcessor(vt, vg);
    else if (S.live.requestVideoFrameCallback) pumpVideoCallback(S.live, vg);
    else throw Object.assign(new Error('This browser cannot deliver camera frames to the encoder.'), { friendly: true });
  }

  function nextTs(tMs) {
    let ts = Math.round(tMs * 1000);
    if (ts <= S.lastTs) ts = S.lastTs + 1;
    S.lastTs = ts;
    return ts;
  }

  async function initEncoder(w, h, vg) {
    w -= w % 2; h -= h % 2;
    const level = w * h > 921600 ? '28' : '1f';
    const bitrate = Math.round(w * h * fpsTarget() * 0.2);
    let cfg = null;
    for (const prof of ['42', '4d', '64']) {
      const c = {
        codec: 'avc1.' + prof + '00' + level, width: w, height: h, bitrate: bitrate,
        framerate: fpsTarget(), latencyMode: 'realtime', avc: { format: 'avc' }
      };
      try {
        const r = await VideoEncoder.isConfigSupported(c);
        if (r && r.supported) { cfg = c; break; }
      } catch (e) { /* try next */ }
    }
    if (S.vgen !== vg) return;
    if (!cfg) throw new Error('No H.264 encoder available in this browser.');
    const enc = new VideoEncoder({
      output: onChunk,
      error: (e) => {
        log('encoder error:', e && e.message);
        if (S.encoder === enc) { S.encoder = null; S.encInit = null; S.ring = []; S.avcC = null; S.needKey = true; }
      }
    });
    enc.configure(cfg);
    S.encoder = enc;
    S.encW = w; S.encH = h;
    S.needKey = true; S.sinceKey = 0;
    log('encoder', cfg.codec, w + 'x' + h, (bitrate / 1e6).toFixed(1) + ' Mbps');
  }

  function onChunk(chunk, meta) {
    try {
      if (meta && meta.decoderConfig && meta.decoderConfig.description) {
        const d = meta.decoderConfig.description;
        S.avcC = new Uint8Array(d instanceof ArrayBuffer ? d.slice(0) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice());
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      S.ring.push({ t: chunk.timestamp / 1000, key: chunk.type === 'key', data: data });
      if (!S.capturing) trimRing();
    } catch (e) { log('onChunk error', e); }
  }

  function ringSpan() {
    return S.ring.length > 1 ? S.ring[S.ring.length - 1].t - S.ring[0].t : 0;
  }

  function trimRing() {
    const r = S.ring;
    if (r.length < 2) return;
    const cut = r[r.length - 1].t - ringKeepMs();
    let idx = -1;
    for (let i = 1; i < r.length; i++) {
      if (r[i].t > cut) break;
      if (r[i].key) idx = i;
    }
    if (idx > 0) r.splice(0, idx);
  }

  function encodeFrame(vf) {
    try {
      S.frames++;
      const now = performance.now();
      S.lastFrameAt = now;
      S.fpsN++;
      if (!S.fpsT0) S.fpsT0 = now;
      if (now - S.fpsT0 >= 2000) {
        S.fps = S.fpsN * 1000 / (now - S.fpsT0);
        if ((S.fpsLogN = (S.fpsLogN || 0) + 1) % 3 === 1) log('actual camera FPS', S.fps.toFixed(1), 'dropped', S.dropped, 'ring', S.ring.length, 'span', Math.round(ringSpan()) + 'ms');
        S.fpsT0 = now; S.fpsN = 0;
        if (S.panelOpen) refreshSettingsUi();
      }
      if (!S.encoder) {
        if (!S.encInit) {
          const vg = S.vgen;
          S.encInit = initEncoder(vf.displayWidth, vf.displayHeight, vg).catch((e) => {
            log('encoder init failed', e && e.message);
            if (S.vgen === vg) stopAll('Video encoder unavailable:\n' + (e && e.message));
          });
        }
        return;
      }
      if (S.encoder.state !== 'configured') return;
      if (S.encoder.encodeQueueSize > 10) { S.dropped++; return; }
      if (vf.displayWidth - (vf.displayWidth % 2) !== S.encW || vf.displayHeight - (vf.displayHeight % 2) !== S.encH) {
        log('frame size changed, re-initialising encoder');
        const old = S.encoder; S.encoder = null; S.encInit = null; S.ring = []; S.avcC = null;
        try { old.close(); } catch (e) { /* ignore */ }
        return;
      }
      const key = S.needKey || S.sinceKey >= keyEvery();
      S.sinceKey = key ? 1 : S.sinceKey + 1;
      S.needKey = false;
      S.encoder.encode(vf, { keyFrame: key });
    } catch (e) {
      log('encodeFrame error', e && e.message);
    } finally {
      try { vf.close(); } catch (e) { /* ignore */ }
    }
  }

  async function pumpProcessor(track, vg) {
    const proc = new MediaStreamTrackProcessor({ track: track });
    const reader = proc.readable.getReader();
    S.reader = reader;
    let minOff = Infinity;
    log('frame source: MediaStreamTrackProcessor');
    try {
      while (S.vgen === vg) {
        const r = await reader.read();
        if (r.done || !r.value) break;
        const frame = r.value;
        if (S.vgen !== vg) { frame.close(); break; }
        const tsMs = frame.timestamp / 1000;
        const off = performance.now() - tsMs;
        if (off < minOff) minOff = off;
        let vf;
        try { vf = new VideoFrame(frame, { timestamp: nextTs(tsMs + minOff) }); } finally { frame.close(); }
        encodeFrame(vf);
      }
    } catch (e) {
      if (S.vgen === vg) log('pump ended:', e && e.message);
    }
  }

  function pumpVideoCallback(video, vg) {
    log('frame source: requestVideoFrameCallback');
    const cb = (now, meta) => {
      if (S.vgen !== vg) return;
      try {
        const t = (meta && (meta.captureTime || meta.presentationTime)) || now;
        const vf = new VideoFrame(video, { timestamp: nextTs(t) });
        encodeFrame(vf);
      } catch (e) { log('rVFC frame error', e && e.message); }
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
  }

  // ---- audio messages / trigger -------------------------------------------
  function onAudioMessage(e) {
    const m = e.data || {};
    if (m.type === 'level') {
      S.micOk = S.ctx && S.ctx.state === 'running';
      if (S.panelOpen) {
        S.meterVal = Math.max(m.peak, S.meterVal * 0.92);
        $('meter-fill').style.width = meterPct(S.meterVal) + '%';
      }
      if (S.calib) calibFeed(m.peak, performance.now());
    } else if (m.type === 'trigger') {
      S.armedPosted = false; // worklet disarmed itself
      if (S.prefs.input !== 'mic') return;
      if (!listening() || S.capturing || S.calib || S.panelOpen || S.switching) return;
      let delta = S.ctx.currentTime - m.t;
      if (!isFinite(delta)) delta = 0;
      delta = Core.clamp(delta, 0, 0.5);
      const T = performance.now() - delta * 1000 + S.offsetMs;
      onTrigger(T, m.peak);
    }
  }

  // Signals are accepted in LIVE mode, and also while a clip plays when AUTO MODE is on.
  function listening() {
    return S.mode === 'live' || (S.mode === 'playback' && S.prefs.auto);
  }

  function wantArmed() {
    return S.running && listening() && !S.capturing && !S.calib && !S.panelOpen && !S.switching && S.prefs.input === 'mic' && S.micOk && ringSpan() >= armSpanMs();
  }

  function updateArming() {
    if (!S.node) return;
    const want = wantArmed();
    if (want !== S.armedPosted) {
      S.armedPosted = want;
      S.node.port.postMessage({ armed: want });
    }
  }

  async function onTrigger(T, peak, src) {
    if (Pose) Pose.mark((src || 'mic') + '_trigger', T);
    const gen = S.gen;
    const pre = preMs(), post = postMs(); // fixed for this event
    const auto = S.mode === 'playback'; // AUTO MODE: signal arrived while a clip was playing
    S.capturing = true;
    if (!auto) setMode('pending');
    updateArming(); // disarm
    updateStatus();
    log((src ? src.toUpperCase() + ' trigger T=' : 'audio trigger T=') + T.toFixed(1), src ? '' : 'peak ' + Core.toDb(peak).toFixed(1) + ' dB thr ' + Core.toDb(S.thr).toFixed(1) + ' dB', 'window -' + pre + '/+' + post + ' ms', auto ? '(auto mode, during playback)' : '');
    try {
      await waitForPost(T, gen, post);
      if (S.gen !== gen) return;
      // still playing the old clip (auto mode): keep it until the new one is ready;
      // if the user pressed NEXT meanwhile we are in LIVE and show the new clip as usual
      if (S.mode !== 'playback') setMode('building');
      const t0 = performance.now();
      const sel = Core.selectClip(S.ring, T, pre, post);
      if (!sel) throw new Error('no video frames in buffer');
      if (!S.avcC) throw new Error('encoder gave no codec configuration');
      const bytes = Mp4.buildMp4({
        samples: sel.samples, width: S.encW, height: S.encH, avcC: S.avcC,
        editStartMs: sel.editStartMs, editDurMs: sel.editDurMs, lastDurMs: sel.frameMs
      });
      const blob = new Blob([bytes], { type: 'video/mp4' });
      const ms = performance.now() - t0;
      log('segment start', sel.samples[0].t.toFixed(1), 'end', sel.samples[sel.samples.length - 1].t.toFixed(1));
      log('clip start', sel.clipStart.toFixed(1), '(T' + (sel.clipStart - T).toFixed(0) + ') end', sel.clipEnd.toFixed(1), '(T+' + (sel.clipEnd - T).toFixed(0) + ')',
        'frames', sel.frames, '(stored ' + sel.samples.length + ')', 'dur', sel.editDurMs.toFixed(0) + 'ms', 'export', ms.toFixed(0) + 'ms', 'bytes', bytes.length);
      if (S.gen !== gen) return;
      await enterPlayback({
        blob: blob, frames: Math.max(1, sel.frames), durMs: sel.editDurMs,
        // encoded frames kept so SAVE can re-render the clip with zoom / grid
        src: { samples: sel.samples, avcC: S.avcC ? S.avcC.slice() : null, w: S.encW, h: S.encH, clipStart: sel.clipStart, clipEnd: sel.clipEnd, frameMs: sel.frameMs }
      });
    } catch (e) {
      log('trigger/export failed:', e && e.message);
      if (S.gen !== gen) return;
      toast('Clip failed: ' + (e && e.message), 'err', 3500);
      if (S.mode !== 'playback') returnToLive(); // in auto mode the old clip simply keeps playing
    } finally {
      if (S.gen === gen) {
        S.capturing = false;
        updateArming();
        updateStatus();
      }
    }
  }

  async function waitForPost(T, gen, post) {
    const target = T + post;
    let flushed = false;
    while (S.gen === gen) {
      const last = S.ring.length ? S.ring[S.ring.length - 1].t : 0;
      if (last >= target) return true;
      const late = performance.now() - target;
      if (late > 300 && !flushed && S.encoder && S.encoder.state === 'configured') {
        flushed = true;
        try { await S.encoder.flush(); S.needKey = true; } catch (e) { log('flush failed', e && e.message); }
        continue;
      }
      if (late > 1500) { log('post-trigger frames incomplete'); return false; }
      await sleep(12);
    }
    return false;
  }

  // ---- playback ------------------------------------------------------------
  async function enterPlayback(clip) {
    const v = $('play');
    const old = S.clip; // AUTO MODE: a clip may already be playing; it is replaced
    clip.url = URL.createObjectURL(clip.blob);
    clip.saved = false;
    S.clip = clip;
    S.frameDur = (clip.durMs / 1000) / clip.frames;
    v.onerror = () => {
      if (S.clip !== clip) return;
      log('playback error', v.error && v.error.message);
      toast('Playback failed on this device', 'err', 3500);
      discardClip();
      returnToLive();
    };
    v.src = clip.url;
    v.loop = true;
    if (old && old.url) { try { URL.revokeObjectURL(old.url); } catch (e) { /* ignore */ } }
    await new Promise((res) => {
      let done = false;
      const fin = () => { if (!done) { done = true; res(); } };
      v.onloadedmetadata = fin;
      setTimeout(fin, 2000);
    });
    if (S.clip !== clip) return; // discarded meanwhile (NEXT / EXIT)
    if (S.mode !== 'building' && S.mode !== 'playback') return;
    $('btn-save').textContent = 'SAVE';
    $('btn-save').classList.remove('saved');
    show('frameinfo', false);
    show('pauseicon', false);
    setMode('playback');
    applyZoom(); // a zoom chosen earlier stays until "Reset zoom"
    try { await v.play(); } catch (e) { log('autoplay blocked', e && e.message); show('pauseicon', true); }
    if (S.slomo) startSlomoLoop(); // slow motion stays on until the SLOMO button is pressed again
    updateSlomoButton();
  }

  function discardClip() {
    stopSlomoTimer();
    const v = $('play');
    try { v.pause(); } catch (e) { /* ignore */ }
    v.onerror = null;
    v.removeAttribute('src');
    try { v.load(); } catch (e) { /* ignore */ }
    if (S.clip && S.clip.url) { try { URL.revokeObjectURL(S.clip.url); } catch (e) { /* ignore */ } }
    S.clip = null;
  }

  function returnToLive() {
    if (!S.running) return;
    setMode('live');
    updateArming();
  }

  function curFrame() {
    const v = $('play');
    const n = S.clip ? S.clip.frames : 1;
    return Core.clamp(Math.floor(v.currentTime / S.frameDur + 1e-4), 0, n - 1);
  }

  function setFrame(f, quiet) {
    const v = $('play');
    const n = S.clip ? S.clip.frames : 1;
    f = Core.clamp(f, 0, n - 1);
    const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : n * S.frameDur;
    v.currentTime = Math.min(dur - 0.001, (f + 0.5) * S.frameDur);
    if (quiet) return;
    $('frameinfo').textContent = (f + 1) + ' / ' + n;
    show('frameinfo', true);
  }

  // ---- slow motion: steps the frames at SLOMO_SPEED (fps), frame-accurate on every browser
  function stopSlomoTimer() { clearTimeout(S.slomoTimer); S.slomoTimer = 0; }

  function startSlomoLoop() {
    stopSlomoTimer();
    if (!S.slomo || S.mode !== 'playback' || !S.clip) return;
    $('play').pause();
    show('pauseicon', false);
    show('frameinfo', false);
    S.slomoF = curFrame();
    const step = () => {
      if (!S.slomo || S.mode !== 'playback' || !S.clip) { S.slomoTimer = 0; return; }
      S.slomoF = (S.slomoF + 1) % Math.max(1, S.clip.frames);
      setFrame(S.slomoF, true);
      S.slomoTimer = setTimeout(step, 1000 / S.prefs.slomoFps);
    };
    S.slomoTimer = setTimeout(step, 1000 / S.prefs.slomoFps);
  }

  function updateSlomoButton() {
    $('btn-slomo').classList.toggle('sel', S.slomo);
    $('btn-slomo').textContent = S.slomo ? 'SLOMO ' + S.prefs.slomoFps + ' fps' : 'SLOMO';
  }

  function onSlomo() {
    if (performance.now() - S.lastScrubEnd < 400) return;
    if (S.mode !== 'playback' || !S.clip) return;
    S.slomo = !S.slomo;
    updateSlomoButton();
    if (S.slomo) startSlomoLoop();
    else {
      stopSlomoTimer();
      show('pauseicon', false);
      show('frameinfo', false);
      $('play').play().catch((e) => log('play failed', e && e.message));
    }
    log('slomo', S.slomo ? 'on ' + S.prefs.slomoFps + ' fps' : 'off');
  }

  function togglePause() {
    const v = $('play');
    if (S.slomo) { // slow motion: pause / resume the stepping
      if (S.slomoTimer) {
        stopSlomoTimer();
        show('pauseicon', true);
        const n = S.clip ? S.clip.frames : 1;
        $('frameinfo').textContent = (S.slomoF + 1) + ' / ' + n;
        show('frameinfo', true);
      } else startSlomoLoop();
      return;
    }
    if (v.paused) {
      v.play().catch((e) => log('play failed', e && e.message));
      show('pauseicon', false);
      show('frameinfo', false);
    } else {
      v.pause();
      show('pauseicon', true);
      const n = S.clip ? S.clip.frames : 1;
      $('frameinfo').textContent = (curFrame() + 1) + ' / ' + n;
      show('frameinfo', true);
    }
  }

  // Tap zones: left/right quarter = one frame back/forward, middle half = pause/resume.
  function stepFrame(d) {
    const v = $('play');
    if (!S.clip) return;
    if (!v.paused) v.pause();
    stopSlomoTimer();
    show('pauseicon', true);
    setFrame(curFrame() + d);
  }
  function tapAt(x) {
    const W = window.innerWidth || 1;
    const r = x / W;
    if (r < EDGE_ZONE) stepFrame(-1);
    else if (r > 1 - EDGE_ZONE) stepFrame(1);
    else togglePause();
  }

  // One finger: tap = pause/resume, horizontal drag = scrub frames.
  // Two fingers (when zoom is enabled in settings): pinch to zoom, move to pan.
  function setupGestures() {
    const g = $('gesture');
    const ptrs = new Map();
    let gs = null;      // single-finger gesture
    let pinch = null;   // two-finger gesture

    function pts() {
      const it = Array.from(ptrs.values());
      return [it[0], it[1]];
    }
    function startPinch() {
      const p = pts();
      const mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
      pinch = {
        d0: Math.max(10, Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)),
        s0: S.zoom.s, tx0: S.zoom.tx, ty0: S.zoom.ty, mx0: mx, my0: my
      };
    }
    function updatePinch() {
      const p = pts();
      const mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      const s = Core.clamp(pinch.s0 * d / pinch.d0, 1, ZOOM_MAX);
      // keep the picture point that was under the fingers at the start under the fingers now
      const px = (pinch.mx0 - pinch.tx0) / pinch.s0;
      const py = (pinch.my0 - pinch.ty0) / pinch.s0;
      S.zoom.s = s;
      S.zoom.tx = mx - s * px;
      S.zoom.ty = my - s * py;
      applyZoom();
    }

    // Mouse wheel = zoom around the cursor (PC). Shift/right/middle-button drag = move the picture.
    g.addEventListener('wheel', (e) => {
      if (S.mode !== 'playback' || !S.prefs.zoomOn) return;
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 100;
      const z = S.zoom;
      const s0 = z.s;
      const s1 = Core.clamp(s0 * Math.exp(-dy * 0.0015), 1, ZOOM_MAX);
      if (s1 === s0) return;
      const px = (e.clientX - z.tx) / s0, py = (e.clientY - z.ty) / s0; // picture point under the cursor
      z.s = s1;
      z.tx = e.clientX - s1 * px;
      z.ty = e.clientY - s1 * py;
      applyZoom();
      clearTimeout(S.zoomSaveT);
      S.zoomSaveT = setTimeout(saveZoom, 300);
    }, { passive: false });

    let pan = null;
    g.addEventListener('pointerdown', (e) => {
      if (S.mode !== 'playback') return;
      if (e.pointerType === 'mouse' && S.prefs.zoomOn && S.zoom.s > 1.001 && (e.button === 1 || e.button === 2 || e.shiftKey)) {
        pan = { id: e.pointerId, x0: e.clientX, y0: e.clientY, tx0: S.zoom.tx, ty0: S.zoom.ty };
        try { g.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        return;
      }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { g.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (ptrs.size === 1) {
        gs = { id: e.pointerId, x0: e.clientX, moved: false, cancelled: false, startFrame: 0 };
      } else {
        if (gs) gs.cancelled = true; // second finger: no tap / scrub any more
        if (ptrs.size === 2 && S.prefs.zoomOn) startPinch();
      }
    });

    g.addEventListener('pointermove', (e) => {
      if (pan && e.pointerId === pan.id) {
        S.zoom.tx = pan.tx0 + (e.clientX - pan.x0);
        S.zoom.ty = pan.ty0 + (e.clientY - pan.y0);
        applyZoom();
        return;
      }
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && ptrs.size >= 2) { updatePinch(); return; }
      if (!gs || gs.cancelled || ptrs.size !== 1 || e.pointerId !== gs.id) return;
      const dx = e.clientX - gs.x0;
      if (!gs.moved && Math.abs(dx) > 14) {
        gs.moved = true;
        $('play').pause();
        stopSlomoTimer();
        gs.startFrame = curFrame();
        show('pauseicon', false);
      }
      if (gs.moved) setFrame(gs.startFrame + Math.trunc(dx / PX_PER_FRAME)); // right = forward
    });

    const end = (e, cancelled) => {
      if (pan && e.pointerId === pan.id) { pan = null; saveZoom(); S.lastScrubEnd = performance.now(); return; }
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (pinch && ptrs.size < 2) {
        pinch = null;
        S.lastScrubEnd = performance.now();
        saveZoom();
      }
      if (gs && e.pointerId === gs.id) {
        if (gs.cancelled || gs.moved) S.lastScrubEnd = performance.now();
        else if (!cancelled) tapAt(gs.x0);
        gs.id = -1;
      }
      if (ptrs.size === 0) { gs = null; pinch = null; }
    };
    g.addEventListener('pointerup', (e) => end(e, false));
    g.addEventListener('pointercancel', (e) => end(e, true));
    g.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---- save ----------------------------------------------------------------
  function pad(n, l) { return String(n).padStart(l || 2, '0'); }
  function makeName() {
    const d = new Date();
    const base = 'DD_Archery_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    if (base === S.lastName) S.nameSeq++; else { S.lastName = base; S.nameSeq = 1; }
    return S.nameSeq > 1 ? base + '_' + S.nameSeq + '.mp4' : base + '.mp4';
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
  }

  // ---- save with the zoom / offset / grid that are shown in the play window ----------
  // The clip's encoded frames are decoded, drawn on a canvas with the same zoom transform and grid,
  // and encoded again (H.264) into a new MP4. Without zoom and grid the original clip is saved as is.
  function overlayNeeded() {
    return (S.prefs.zoomOn && S.zoom.s > 1.001) || S.prefs.gridOn;
  }

  async function renderOverlayClip(clip) {
    const src = clip.src;
    if (!src || !src.avcC) throw new Error('clip data missing');
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) throw new Error('no video decoder');
    const W = src.w, H = src.h;
    const vw = window.innerWidth || W, vh = window.innerHeight || H;
    // the <video> fills the screen with object-fit: contain: k = scale, (ox, oy) = offset of the picture
    const k = Math.min(vw / W, vh / H);
    const ox = (vw - k * W) / 2, oy = (vh - k * H) / 2;
    const zoomOn = S.prefs.zoomOn && S.zoom.s > 1.001;
    const zs = zoomOn ? S.zoom.s : 1, tx = zoomOn ? S.zoom.tx : 0, ty = zoomOn ? S.zoom.ty : 0;
    // screen = t + zs * (o + k*u)  ->  output pixel X = (screen - o) / k  (output = the unzoomed picture area)
    const mx = (tx - ox + zs * ox) / k, my = (ty - oy + zs * oy) / k;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const drawGrid = () => {
      const c = GRID_COLORS[S.prefs.gridColor] || GRID_COLORS.white;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (S.prefs.gridInt / 10) + ')';
      const gs = S.prefs.gridSize;
      const lw = Math.max(1, Math.round(1 / k));
      const cx = vw / 2, cy = vh / 2; // a grid line passes through the screen centre
      for (let x = cx - Math.ceil((cx - ox) / gs) * gs; x <= ox + k * W + 0.5; x += gs) {
        const X = Math.round((x - ox) / k);
        if (X >= 0 && X < W) ctx.fillRect(X, 0, lw, H);
      }
      for (let y = cy - Math.ceil((cy - oy) / gs) * gs; y <= oy + k * H + 0.5; y += gs) {
        const Y = Math.round((y - oy) / k);
        if (Y >= 0 && Y < H) ctx.fillRect(0, Y, W, lw);
      }
    };

    const fps = Core.clamp(1000 / (src.frameMs || 33.3), 5, 60);
    let cfg = null;
    for (const prof of ['42', '4d', '64']) {
      const c = {
        codec: 'avc1.' + prof + '00' + (W * H > 921600 ? '28' : '1f'), width: W, height: H,
        bitrate: Math.round(W * H * fps * 0.25), framerate: fps, avc: { format: 'avc' }
      };
      try { const r = await VideoEncoder.isConfigSupported(c); if (r && r.supported) { cfg = c; break; } } catch (e) { /* next */ }
    }
    if (!cfg) throw new Error('no H.264 encoder');

    const out = [];
    let outAvcC = null, encErr = null, decErr = null, tFirst = null, nOut = 0;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description) {
          const d = meta.decoderConfig.description;
          outAvcC = new Uint8Array(d instanceof ArrayBuffer ? d.slice(0) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice());
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        out.push({ t: chunk.timestamp / 1000, key: chunk.type === 'key', data: data });
      },
      error: (e) => { encErr = e; }
    });
    enc.configure(cfg);
    const av = src.avcC;
    const dec = new VideoDecoder({
      output: (vf) => {
        try {
          const t = vf.timestamp / 1000;
          if (t < src.clipStart - 0.5 || t >= src.clipEnd) return; // outside the visible part of the clip
          if (tFirst === null) tFirst = t;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, H);
          ctx.setTransform(zs, 0, 0, zs, mx, my);
          ctx.drawImage(vf, 0, 0, W, H);
          if (S.prefs.gridOn) drawGrid();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          const of = new VideoFrame(canvas, { timestamp: Math.round((t - tFirst) * 1000) });
          try { enc.encode(of, { keyFrame: nOut % Math.max(5, Math.round(fps / 3)) === 0 }); } finally { of.close(); }
          nOut++;
        } catch (e) { decErr = e; } finally { try { vf.close(); } catch (e2) { /* ignore */ } }
      },
      error: (e) => { decErr = e; }
    });
    dec.configure({
      codec: 'avc1.' + [av[1], av[2], av[3]].map((b) => b.toString(16).padStart(2, '0')).join(''),
      description: av
    });
    try {
      for (const sm of src.samples) {
        if (decErr || encErr) break;
        dec.decode(new EncodedVideoChunk({ type: sm.key ? 'key' : 'delta', timestamp: Math.round(sm.t * 1000), data: sm.data }));
        let guard = 0;
        while ((dec.decodeQueueSize > 6 || enc.encodeQueueSize > 6) && guard++ < 2000) await sleep(2);
      }
      await dec.flush();
      await enc.flush();
    } finally {
      try { dec.close(); } catch (e) { /* ignore */ }
      try { enc.close(); } catch (e) { /* ignore */ }
    }
    if (decErr || encErr) throw new Error('render: ' + ((decErr || encErr).message || 'codec error'));
    if (!out.length || !outAvcC) throw new Error('render produced no frames');
    const frameMs = src.frameMs || 33.3;
    const bytes = Mp4.buildMp4({
      samples: out, width: W, height: H, avcC: outAvcC,
      editStartMs: 0, editDurMs: out[out.length - 1].t - out[0].t + frameMs, lastDurMs: frameMs
    });
    log('rendered with zoom x' + zs.toFixed(2) + (S.prefs.gridOn ? ' + grid ' + S.prefs.gridSize + 'px' : ''), 'frames', out.length, 'bytes', bytes.length);
    return new Blob([bytes], { type: 'video/mp4' });
  }

  async function onSave() {
    if (performance.now() - S.lastScrubEnd < 400) return; // swipe just ended
    if (!S.clip || S.saving || S.mode !== 'playback') return;
    S.saving = true;
    const clip = S.clip;
    const name = makeName();
    try {
      let outBlob = clip.blob, note = '';
      if (overlayNeeded()) {
        $('btn-save').textContent = 'RENDERING…';
        toast('Rendering with zoom / grid…', null, 4000);
        try {
          outBlob = await Promise.race([
            renderOverlayClip(clip),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
          ]);
        } catch (e) {
          log('overlay render failed:', e && e.message);
          note = '\n(original clip: zoom/grid could not be added)';
          outBlob = clip.blob;
        }
        if (S.clip !== clip) { S.saving = false; return; } // NEXT / EXIT / new clip meanwhile
      }
      let done = false;
      if (isIOS && navigator.canShare && typeof File === 'function') {
        const file = new File([outBlob], name, { type: 'video/mp4' });
        if (navigator.canShare({ files: [file] })) {
          S.sharing = true;
          try {
            await navigator.share({ files: [file], title: name });
            toast('Saved: ' + name + note, 'ok', 3500);
            done = true;
          } catch (e) {
            if (e && e.name === 'AbortError') { toast('Save cancelled', null, 1800); S.saving = false; S.sharing = false; return; }
            log('share failed, falling back to download', e && e.message);
          } finally { S.sharing = false; }
        }
      }
      if (!done) {
        downloadBlob(outBlob, name);
        toast('Saved: ' + name + (isIOS ? '' : '\n(Downloads folder)') + note, note ? 'err' : 'ok', note ? 4500 : 3000);
      }
      clip.saved = true;
      $('btn-save').textContent = 'SAVED';
      $('btn-save').classList.add('saved');
      log('saved', name, outBlob.size, 'bytes');
    } catch (e) {
      log('save failed', e && e.message);
      toast('Save failed: ' + (e && e.message), 'err', 3500);
    } finally {
      S.saving = false;
    }
  }

  function onNext() {
    if (performance.now() - S.lastScrubEnd < 400) return;
    if (S.mode !== 'playback') return;
    discardClip();
    returnToLive();
  }

  // ---- calibration ---------------------------------------------------------
  function showBanner(text) {
    $('banner-text').textContent = text;
    show('banner', true);
  }

  function startCalibration() {
    closePanel();
    S.calib = { phase: 'noise', noise: [], t0: performance.now(), shots: [], cur: null, lockUntil: 0, shotMin: 0, noiseLevel: 0, pendingBanner: false };
    updateArming();
    showBanner('Calibrating…\nstay quiet');
    updateStatus();
    log('calibration started');
  }

  function cancelCalibration() {
    if (!S.calib) return;
    S.calib = null;
    show('banner', false);
    updateArming();
    updateStatus();
    log('calibration cancelled');
  }

  function calibFeed(peak, now) {
    const c = S.calib;
    if (!c || c.phase === 'done') return;
    if (c.phase === 'noise') {
      c.noise.push(peak);
      if (now - c.t0 >= 1500) {
        c.noiseLevel = Core.percentile(c.noise, 0.98);
        c.shotMin = Math.max(c.noiseLevel * 4, 0.02);
        c.phase = 'shot';
        c.lockUntil = now + 300;
        showBanner('Shot 1/3\nmake a normal shot');
        log('calibration noise level', Core.toDb(c.noiseLevel).toFixed(1) + ' dB');
      }
      return;
    }
    if (c.pendingBanner && now >= c.lockUntil) {
      c.pendingBanner = false;
      showBanner('Shot ' + (c.shots.length + 1) + '/3\nmake a normal shot');
    }
    if (now < c.lockUntil) return;
    if (!c.cur) {
      if (peak >= c.shotMin) c.cur = { max: peak, start: now };
      return;
    }
    if (peak > c.cur.max) c.cur.max = peak;
    if (now - c.cur.start >= 250) {
      c.shots.push(c.cur.max);
      log('calibration shot', c.shots.length, Core.toDb(c.cur.max).toFixed(1) + ' dB');
      c.cur = null;
      c.lockUntil = now + 1000;
      if (c.shots.length >= 3) {
        finishCalibration();
      } else {
        showBanner('✓ Shot ' + c.shots.length + '/3');
        c.pendingBanner = true;
      }
    }
  }

  function finishCalibration() {
    const c = S.calib;
    c.phase = 'done';
    const thr = Core.computeThreshold(c.noiseLevel, c.shots);
    applyThreshold(thr, true);
    showBanner('Calibration complete\n' + Core.toDb(thr).toFixed(1) + ' dB');
    log('calibration complete, noise', Core.toDb(c.noiseLevel).toFixed(1), 'shots', c.shots.map((s) => Core.toDb(s).toFixed(1)).join(','), 'thr', Core.toDb(thr).toFixed(1));
    const gen = S.gen;
    setTimeout(() => {
      if (S.gen !== gen) return;
      if (S.calib === c) {
        S.calib = null;
        show('banner', false);
        updateArming();
        updateStatus();
      }
    }, 2200);
  }

  // ---- settings panel ------------------------------------------------------
  function openPanel() {
    if (S.mode !== 'live') return;
    S.panelOpen = true;
    S.meterVal = 0;
    refreshSettingsUi();
    show('panel', true);
    applyGrid();
    updateArming();
    updateStatus();
    refreshCameras();
  }

  function closePanel() {
    S.panelOpen = false;
    show('panel', false);
    show('debug-log', false);
    show('btn-debug-copy', false);
    $('panel-box').classList.remove('debug-open');
    applyGrid();
    updateArming();
    updateStatus();
  }

  // 30 / 60 fps: the camera is re-opened with the new frame rate (the microphone is not touched)
  async function setFps(n) {
    if (n === S.prefs.fps) return;
    if (n === 60 && S.fpsMax !== null && S.fpsMax < 59) { toast('This camera does not support 60 fps.', 'err', 3000); return; }
    S.prefs.fps = n;
    savePrefs();
    refreshSettingsUi();
    log('filming fps', n);
    if (!S.running || S.mode !== 'live') return;
    await switchCamera(S.camId || S.prefs.cam || null, true);
    if (n === 60 && S.running && S.fpsActual && S.fpsActual < 55) {
      toast('Camera delivers only ' + Math.round(S.fpsActual) + ' fps. Back to 30 fps.', 'err', 4000);
      S.prefs.fps = 30; savePrefs();
      await switchCamera(S.camId || S.prefs.cam || null, true);
    }
    refreshSettingsUi();
  }

  function flipCamera() {
    if (S.cams.length < 2) return;
    let i = S.cams.findIndex((c) => c.id === S.camId);
    if (i < 0) i = 0;
    switchCamera(S.cams[(i + 1) % S.cams.length].id);
  }

  // ---- trigger input: MIC or BT (Web Bluetooth) -----------------------------
  function btSupported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }

  function btUuid1(str) {
    const t = String(str || '').trim().toLowerCase();
    if (/^(0x)?[0-9a-f]{4}$/.test(t) || /^(0x)?[0-9a-f]{8}$/.test(t)) return parseInt(t, 16);
    return t;
  }
  // the service field may hold several UUIDs separated by comma / space / semicolon
  function btUuids() {
    const list = String(BT_SERVICES).split(/[\s,;]+/).filter(Boolean).map(btUuid1);
    return list.length ? list : [NUS_SERVICE];
  }

  function setBtState(st) {
    S.bt.state = st;
    refreshSettingsUi();
    updateStatus();
  }

  function setBattery(n) {
    S.bt.battery = Core.clamp(n, 0, 100);
    refreshSettingsUi();
    updateTopbar();
  }

  // "MOT" = signal (same as a microphone trigger); digits after it = battery percentage
  function handleBtText(text) {
    log('bt rx', JSON.stringify(text));
    const re = /MOT\s*[:=,]?\s*(\d{1,3})?/gi;
    let m, hit = false;
    while ((m = re.exec(text))) {
      hit = true;
      if (m[1] !== undefined) setBattery(parseInt(m[1], 10));
    }
    const b = /BAT\s*[:=]?\s*(\d{1,3})/i.exec(text);
    if (b && !hit) setBattery(parseInt(b[1], 10));
    if (hit) onBtSignal();
  }

  function onBtSignal() { onRemoteSignal('bt', S.bt); }

  // BT / PHONE signal: same as a microphone trigger at the moment it arrives (+ Sync offset)
  function onRemoteSignal(src, st) {
    const now = performance.now();
    if (S.prefs.input !== src || !S.running) return;
    if (!listening() || S.capturing || S.calib || S.panelOpen || S.switching) { log(src + ' signal ignored (not listening)'); return; }
    if (ringSpan() < armSpanMs()) { log(src + ' signal ignored (buffer warming up)'); return; }
    if (now - st.lastSig < BT_LOCKOUT_MS) return;
    st.lastSig = now;
    onTrigger(now + S.offsetMs, 0, src);
  }

  function onBtValue(e) {
    try {
      const dv = e.target.value;
      handleBtText(new TextDecoder().decode(dv));
    } catch (err) { log('bt value error', err && err.message); }
  }

  function onBtBatteryValue(e) {
    try { setBattery(e.target.value.getUint8(0)); } catch (err) { /* ignore */ }
  }

  function btClearRetry() { clearTimeout(S.bt.retryTimer); S.bt.retryTimer = 0; }

  function btScheduleRetry(gen) {
    btClearRetry();
    if (!S.bt.want || !S.running || S.prefs.input !== 'bt') return;
    S.bt.retryTimer = setTimeout(() => { if (S.gen === gen) btOpen(S.bt.dev, gen); }, 2500);
  }

  function onBtDisconnected() {
    S.bt.chars = [];
    S.bt.server = null;
    if (!S.bt.want || !S.running || S.prefs.input !== 'bt') return;
    log('bt disconnected');
    setBtState('lost');
    btScheduleRetry(S.gen);
  }

  async function btOpen(dev, gen) {
    if (!dev || S.bt.busy) return;
    S.bt.busy = true;
    setBtState(S.bt.state === 'lost' ? 'lost' : 'connecting');
    try {
      const server = await dev.gatt.connect();
      if (S.gen !== gen || S.prefs.input !== 'bt' || !S.bt.want) { try { server.disconnect(); } catch (e) { /* ignore */ } return; }
      S.bt.server = server;
      let n = 0;
      const found = [];
      for (const u of btUuids()) {
        let svc;
        try { svc = await server.getPrimaryService(u); } catch (e) { log('bt service', u, 'not on device:', e && e.name); continue; }
        found.push(String(u));
        try {
          const chars = await svc.getCharacteristics();
          for (const c of chars) {
            log('bt characteristic', c.uuid, JSON.stringify({ notify: !!c.properties.notify, indicate: !!c.properties.indicate, read: !!c.properties.read, write: !!(c.properties.write || c.properties.writeWithoutResponse) }));
            if (c.properties.notify || c.properties.indicate) {
              await c.startNotifications();
              c.addEventListener('characteristicvaluechanged', onBtValue);
              S.bt.chars.push(c);
              n++;
            }
          }
        } catch (e) { log('bt characteristics error', e && e.name, e && e.message); }
      }
      // optional: standard battery service
      try {
        const bs = await server.getPrimaryService('battery_service');
        const bc = await bs.getCharacteristic('battery_level');
        try { setBattery((await bc.readValue()).getUint8(0)); } catch (e) { /* ignore */ }
        if (bc.properties.notify) { await bc.startNotifications(); bc.addEventListener('characteristicvaluechanged', onBtBatteryValue); S.bt.chars.push(bc); }
      } catch (e) { /* no battery service: fine */ }
      if (S.gen !== gen || S.prefs.input !== 'bt' || !S.bt.want) { try { server.disconnect(); } catch (e) { /* ignore */ } return; }
      if (!n) {
        S.bt.want = false;
        try { server.disconnect(); } catch (e) { /* ignore */ }
        setBtState('off');
        toast(found.length
          ? 'BT: service found, but it has no notify characteristic.\nThe firmware must send MOT as a notification.'
          : 'BT: none of the built-in service UUIDs is on this device.\nCheck the firmware (see Debug log).', 'err', 7000);
        return;
      }
      log('bt connected', dev.name, n + ' notify characteristic(s)');
      setBtState('connected');
      toast('BT connected: ' + (dev.name || ''), 'ok', 1800);
    } catch (e) {
      log('bt connect failed', e && e.name, e && e.message);
      if (S.gen === gen && S.bt.want && S.prefs.input === 'bt') {
        setBtState('lost');
        btScheduleRetry(gen);
      }
    } finally {
      S.bt.busy = false;
    }
  }

  // fromUser = true: show the browser's device chooser (needs a tap). false: silently reuse a device that was allowed earlier.
  async function btConnect(fromUser) {
    if (!btSupported() || S.bt.busy || S.prefs.input !== 'bt' || !S.running) return;
    const gen = S.gen;
    const name = S.prefs.btName || BT_DEFAULT_NAME;
    btClearRetry();
    S.bt.want = true;
    try {
      let dev = null;
      if (fromUser) {
        S.bt.busy = true; // keep the chooser from opening twice
        try {
          dev = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: name }],
            optionalServices: btUuids().concat(['battery_service'])
          });
        } finally { S.bt.busy = false; }
      } else if (navigator.bluetooth.getDevices) {
        const list = await navigator.bluetooth.getDevices();
        dev = list.find((d) => d.name === name) || null;
      }
      if (S.gen !== gen || S.prefs.input !== 'bt') return;
      if (!dev) {
        S.bt.want = false;
        setBtState('off');
        if (!fromUser) toast('BT: tap "Connect BT" and choose ' + name, null, 3500);
        return;
      }
      if (S.bt.dev !== dev) {
        if (S.bt.dev) { try { S.bt.dev.removeEventListener('gattserverdisconnected', onBtDisconnected); } catch (e) { /* ignore */ } }
        S.bt.dev = dev;
        dev.addEventListener('gattserverdisconnected', onBtDisconnected);
      }
      await btOpen(dev, gen);
    } catch (e) {
      log('bt request failed', e && e.name, e && e.message);
      S.bt.want = false;
      setBtState('off');
      if (e && e.name !== 'NotFoundError') toast('BT: ' + (e.message || e.name), 'err', 4000); // NotFoundError = chooser cancelled
    }
  }

  function btDisconnect() {
    S.bt.want = false;
    btClearRetry();
    const dev = S.bt.dev;
    S.bt.chars.forEach((c) => { try { c.removeEventListener('characteristicvaluechanged', onBtValue); c.removeEventListener('characteristicvaluechanged', onBtBatteryValue); } catch (e) { /* ignore */ } });
    S.bt.chars = [];
    try { if (dev && dev.gatt && dev.gatt.connected) dev.gatt.disconnect(); } catch (e) { /* ignore */ }
    S.bt.server = null;
    S.bt.state = 'off';
    S.bt.battery = null;
    S.bt.busy = false;
    refreshSettingsUi();
    updateTopbar();
  }

  // switch the microphone off completely (BT mode): no capture, no audio graph, indicator off
  function stopMic() {
    try { if (S.node) { S.node.port.postMessage({ armed: false }); S.node.port.onmessage = null; S.node.disconnect(); } } catch (e) { /* ignore */ }
    try { if (S.srcNode) S.srcNode.disconnect(); } catch (e) { /* ignore */ }
    try { if (S.gainNode) S.gainNode.disconnect(); } catch (e) { /* ignore */ }
    S.node = null; S.srcNode = null; S.gainNode = null; S.armedPosted = false; S.micOk = false;
    try {
      if (S.stream) S.stream.getAudioTracks().forEach((t) => { try { S.stream.removeTrack(t); } catch (e) { /* ignore */ } t.stop(); });
    } catch (e) { /* ignore */ }
    const ctx = S.ctx; S.ctx = null;
    try { if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {}); } catch (e) { /* ignore */ }
    log('microphone off');
  }

  // back to the microphone (called from a tap: the AudioContext must be created inside it)
  async function startMic() {
    if (S.micStarting || S.node || !S.running) return;
    S.micStarting = true;
    const gen = S.gen;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('no Web Audio support');
      S.ctx = new AC({ latencyHint: 'interactive' });
      S.ctx.resume().catch(() => {});
      const as = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      if (S.gen !== gen || S.prefs.input !== 'mic') { as.getTracks().forEach((t) => t.stop()); return; }
      as.getAudioTracks().forEach((t) => S.stream.addTrack(t));
      await setupAudio(gen);
    } catch (e) {
      log('mic start failed', e && e.name, e && e.message);
      toast(explainMediaError(e, 'Microphone'), 'err', 4000);
    } finally {
      S.micStarting = false;
      updateArming();
      updateStatus();
    }
  }

  function setInput(m) {
    if (m === S.prefs.input) return;
    if (m === 'bt' && !btSupported()) {
      toast('Web Bluetooth is not available in this browser.\nUse Android Chrome or desktop Chrome/Edge.', 'err', 5000);
      return;
    }
    if (S.calib) cancelCalibration();
    S.prefs.input = m;
    savePrefs();
    if (S.running) {
      if (m === 'bt') { phoneDisconnect(); btConnect(true); stopMic(); }   // the chooser must open straight from the tap
      else if (m === 'phone') { btDisconnect(); stopMic(); phoneConnect(); }
      else if (m === 'ai') { btDisconnect(); phoneDisconnect(); stopMic(); }
      else { btDisconnect(); phoneDisconnect(); startMic(); }
    }
    refreshSettingsUi();
    updateArming();
    updateStatus();
    applyPose();
    log('input', m);
  }

  function commitBtName() {
    let v = $('bt-name').value.trim().slice(0, 32);
    if (!v) v = BT_DEFAULT_NAME;
    const changed = v !== S.prefs.btName;
    S.prefs.btName = v;
    $('bt-name').value = v;
    savePrefs();
    if (changed && S.bt.dev) { btDisconnect(); S.bt.dev = null; }
    refreshSettingsUi();
    updateStatus();
  }

  // ---- trigger input: PHONE (MOT from a second phone over MQTT/WSS) ---------
  function phSetState(st) {
    S.ph.state = st;
    refreshSettingsUi();
    updateStatus();
  }

  function phClearRetry() { clearTimeout(S.ph.retryTimer); S.ph.retryTimer = 0; }

  function phScheduleRetry(gen) {
    phClearRetry();
    if (!S.ph.want || !S.running || S.prefs.input !== 'phone') return;
    const ms = Math.min(15000, 2500 * Math.pow(2, S.ph.tries)); // 2.5, 5, 10, 15, 15 … s
    S.ph.tries++;
    S.ph.retryTimer = setTimeout(() => { if (S.gen === gen) phoneConnect(); }, ms);
  }

  function onPhoneMessage(topic, payload) {
    if (topic === Phone.cfgTopicFor(S.prefs.room)) { onLooperConfig(payload); return; }
    if (topic !== Phone.topicFor(S.prefs.room)) return;
    const pk = Phone.parsePeak(payload);
    if (pk) {
      S.ph.lastPeak = pk.p;
      log('phone peak', pk.p);
      updateTopbar();
      if (S.panelOpen) refreshSettingsUi();
      return;
    }
    const m = Phone.parseTrigger(payload);
    log('phone rx', JSON.stringify(payload).slice(0, 120));
    if (!m) return;
    S.ph.lastA = m.a;
    S.ph.lastRxAt = Date.now();
    if (S.panelOpen) refreshSettingsUi();
    onRemoteSignal('phone', S.ph);
  }

  async function phoneConnect() {
    if (!S.running || S.prefs.input !== 'phone' || S.ph.busy) return;
    const gen = S.gen;
    const room = S.prefs.room, url = S.prefs.mqttUrl;
    S.ph.want = true;
    phClearRetry();
    if (!Phone.validRoom(room)) { S.ph.want = false; S.ph.err = 'Room code must have at least ' + Phone.ROOM_MIN + ' letters/digits.'; phSetState('off'); return; }
    S.ph.busy = true;
    phSetState(S.ph.state === 'lost' ? 'lost' : 'connecting');
    let client = null, again = false;
    try {
      client = await Phone.connect({
        url: url,
        subscribe: [Phone.topicFor(room), Phone.cfgTopicFor(room)],
        onMessage: onPhoneMessage,
        onClose: (reason) => {
          if (S.ph.client !== client) return; // closed on purpose
          S.ph.client = null;
          log('phone trigger connection closed:', reason);
          if (!S.ph.want || !S.running || S.prefs.input !== 'phone') return;
          S.ph.err = 'Connection lost (' + reason + ').';
          phSetState('lost');
          phScheduleRetry(S.gen);
        }
      });
      if (S.gen !== gen || !S.ph.want || S.prefs.input !== 'phone' || room !== S.prefs.room || url !== S.prefs.mqttUrl) {
        client.close();
        again = S.gen === gen && S.ph.want; // room / server changed meanwhile: connect again with the new values
        return;
      }
      S.ph.client = client;
      S.ph.tries = 0;
      S.ph.err = '';
      log('phone trigger connected', url, 'room', room);
      phSetState('connected');
      toast('PHONE connected, room ' + room, 'ok', 1800);
    } catch (e) {
      log('phone connect failed:', e && e.message);
      if (S.gen === gen && S.ph.want && S.prefs.input === 'phone') {
        if (!S.ph.err) toast('PHONE: ' + (e && e.message), 'err', 4000); // first failure only, then it retries quietly
        S.ph.err = (e && e.message) || 'Connection failed.';
        phSetState('lost');
        phScheduleRetry(gen);
      }
    } finally {
      S.ph.busy = false;
      if (again) phoneConnect();
    }
  }

  // new room code / server: drop the current connection and connect again
  function phoneReconnect() {
    if (!S.running || S.prefs.input !== 'phone') return;
    const c = S.ph.client;
    S.ph.client = null;
    try { if (c) c.close(); } catch (e) { /* ignore */ }
    S.ph.tries = 0;
    S.ph.err = '';
    phClearRetry();
    phoneConnect();
  }

  function phoneDisconnect() {
    S.ph.want = false;
    phClearRetry();
    const c = S.ph.client;
    S.ph.client = null;
    try { if (c) c.close(); } catch (e) { /* ignore */ }
    S.ph.state = 'off';
    S.ph.tries = 0;
    S.ph.err = '';
    refreshSettingsUi();
    updateTopbar();
  }

  function commitRoom() {
    const v = Phone.cleanRoom($('ph-room').value);
    if (!Phone.validRoom(v)) {
      toast('Room code needs at least ' + Phone.ROOM_MIN + ' letters/digits.', 'err', 3000);
      $('ph-room').value = S.prefs.room;
      return;
    }
    $('ph-room').value = v;
    if (v === S.prefs.room) return;
    S.prefs.room = v;
    savePrefs();
    log('phone room', v);
    refreshSettingsUi();
    updateTopbar();
    phoneReconnect();
  }

  function commitMqttUrl() {
    const v = Phone.cleanUrl($('ph-url').value).slice(0, 200);
    $('ph-url').value = v;
    if (v === S.prefs.mqttUrl) return;
    S.prefs.mqttUrl = v;
    savePrefs();
    log('phone server', v);
    refreshSettingsUi();
    phoneReconnect();
  }

  // Sensor threshold is shared by both phones: either side publishes a retained CFG when it is changed there,
  // both sides apply what they receive, so the last change wins and nothing is overwritten on (re)connect.
  function onLooperConfig(payload) {
    const m = Phone.parseConfig(payload);
    if (!m) return;
    const thr = Core.clamp(Math.round(m.thr * 2) / 2, MOTION_MIN, MOTION_MAX);
    if (thr === S.prefs.sensorThr) return;
    S.prefs.sensorThr = thr;
    savePrefs();
    log('sensor threshold from the room', thr);
    refreshSettingsUi();
  }

  function sendSensorThr() {
    const c = S.ph.client;
    if (!c || !Phone.validRoom(S.prefs.room)) return false;
    const ok = c.publish(Phone.cfgTopicFor(S.prefs.room), Phone.cfgPayload(S.prefs.sensorThr), true);
    log('sensor threshold sent', S.prefs.sensorThr, ok ? '' : '(failed)');
    return ok;
  }

  function setSensorThr(v, announce) {
    S.prefs.sensorThr = Core.clamp(Math.round((parseFloat(v) || MOTION_DEFAULT) * 2) / 2, MOTION_MIN, MOTION_MAX);
    savePrefs();
    refreshSettingsUi();
    const sent = sendSensorThr();
    if (announce) toast('Sensor threshold ' + S.prefs.sensorThr.toFixed(1) + ' m/s²' + (sent ? '\nsent to the sensor phone' : '\nis sent when PHONE is connected'), sent ? 'ok' : null, 2200);
  }

  async function copyRoom() {
    try { await navigator.clipboard.writeText(S.prefs.room); toast('Room code copied: ' + S.prefs.room, 'ok', 2000); }
    catch (e) { toast('Copy not possible. Room code: ' + S.prefs.room, null, 4000); }
  }

  // ---- MOTION SENDER: this phone is the sensor --------------------------------
  function sndStatus(text, kind) {
    const el = $('snd-status');
    el.textContent = text;
    el.style.color = kind === 'err' ? '#ff8a80' : kind === 'ok' ? '#7ee787' : '';
  }

  function sndUi() {
    const a = S.snd.active;
    show('btn-snd-start', !a);
    $('btn-snd-start').disabled = S.snd.busy;
    $('btn-snd-stop').disabled = !a;
    const open = !!(S.snd.client && S.snd.client.open);
    $('btn-snd-test').disabled = !open;
    show('btn-snd-hide', a);
    $('snd-dot').classList.toggle('ok', open);
    $('snd-lock-text').textContent = !open ? 'NOT CONNECTED' : S.snd.noData ? 'NO SENSOR DATA' : 'SENSOR ON';
    $('snd-room').disabled = a;
    $('snd-url').disabled = a;
    $('btn-snd-url-reset').disabled = a;
    $('snd-thr').value = String(S.prefs.motionThr);
    $('snd-thr-text').textContent = S.prefs.motionThr.toFixed(1) + ' m/s²';
  }

  // While the sensor runs the screen is locked: black, every touch ignored, only a small gear in the
  // corner (held GEAR_HOLD_MS) opens the settings again, so a phone held in the hand or a pocket cannot press buttons.
  function sndLock(on) {
    clearTimeout(S.snd.lockTimer);
    S.snd.locked = !!on && S.snd.active;
    show('snd-lock', S.snd.locked);
    show('snd-gear-hint', false);
    if (S.snd.locked) {
      try { if (document.activeElement) document.activeElement.blur(); } catch (e) { /* ignore */ }
      sndEnterFullscreen();
    }
    else sndArmAutoLock();
  }

  // Full screen hides the browser bars and the system buttons that a hand or pocket would press.
  // It needs a tap: requested from START SENSOR / Hide / any touch on the lock screen. Stays on until the sensor stops.
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function fsSupported() { const de = document.documentElement; return !!(de.requestFullscreen || de.webkitRequestFullscreen); }

  async function sndEnterFullscreen(force) {
    if (!S.snd.active && !force) return;
    const de = document.documentElement;
    if (!fsElement()) {
      const req = de.requestFullscreen || de.webkitRequestFullscreen;
      if (!req) return;
      try { await req.call(de, { navigationUI: 'hide' }); log('sender fullscreen on'); }
      catch (e) { log('sender fullscreen failed:', e && e.message); return; }
    }
    try {
      const so = screen.orientation;
      if (so && so.lock && so.type) await so.lock(/^landscape/.test(so.type) ? 'landscape' : 'portrait');
    } catch (e) { /* orientation lock not available: fine */ }
  }

  function sndExitFullscreen() {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* ignore */ }
    if (!fsElement()) return;
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    try { const r = ex && ex.call(document); if (r && r.catch) r.catch(() => {}); } catch (e) { /* ignore */ }
  }

  function sndArmAutoLock() {
    clearTimeout(S.snd.lockTimer);
    if (S.snd.active && !S.snd.locked) S.snd.lockTimer = setTimeout(() => sndLock(true), SND_AUTOLOCK_MS);
  }

  function sndFlash() {
    const d = $('snd-dot');
    d.classList.add('flash');
    clearTimeout(S.snd.flashTimer);
    S.snd.flashTimer = setTimeout(() => d.classList.remove('flash'), 300);
  }

  function setupSenderLock() {
    const g = $('btn-snd-gear');
    let t = 0, hintT = 0;
    const cancel = () => { clearTimeout(t); t = 0; g.classList.remove('holding'); };
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      cancel();
      g.classList.add('holding');
      t = setTimeout(() => { t = 0; cancel(); sndLock(false); log('sender settings opened'); }, GEAR_HOLD_MS);
    });
    g.addEventListener('pointerup', () => {
      if (!t) return;
      cancel(); // released too early: only a hint
      show('snd-gear-hint', true);
      clearTimeout(hintT);
      hintT = setTimeout(() => show('snd-gear-hint', false), 1500);
    });
    g.addEventListener('pointercancel', cancel);
    g.addEventListener('pointerleave', cancel);
    const lock = $('snd-lock');
    ['pointerdown', 'touchstart', 'contextmenu', 'dblclick'].forEach((ev) =>
      lock.addEventListener(ev, (e) => { if (!g.contains(e.target)) e.preventDefault(); }, { passive: false }));
    // full screen was left (system back gesture) or refused without a tap: any touch on the lock screen asks again.
    // pointerup, not pointerdown: on touch screens the browser counts the tap as a user gesture only when the finger lifts
    lock.addEventListener('pointerup', () => { if (!fsElement()) sndEnterFullscreen(); });
    // any touch in the open settings keeps them open a little longer
    $('sender').addEventListener('pointerdown', () => { if (!S.snd.locked) sndArmAutoLock(); }, true);
    $('sender').addEventListener('input', () => { if (!S.snd.locked) sndArmAutoLock(); }, true);
  }

  function openSender() {
    if (S.running || S.starting) return;
    $('snd-room').value = S.prefs.sndRoom;
    $('snd-url').value = S.prefs.mqttUrl;
    show('start', false);
    show('sender', true);
    // iPhone Safari has no full screen for web pages; a Home Screen app is the closest (no browser bars)
    show('snd-fs-hint', !fsSupported() && !window.navigator.standalone && !matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches);
    sndUi();
    log('motion sender screen');
  }

  function closeSender() {
    stopSender('');
    show('sender', false);
    show('start', true);
  }

  async function sndAcquireWake() {
    try {
      if (S.snd.active && 'wakeLock' in navigator && !S.snd.wake) {
        S.snd.wake = await navigator.wakeLock.request('screen');
        S.snd.wake.addEventListener('release', () => { S.snd.wake = null; });
      }
    } catch (e) { log('sender wake lock unavailable', e && e.message); }
  }

  async function startSender() {
    if (S.snd.active || S.snd.busy) return;
    const room = Phone.cleanRoom($('snd-room').value);
    $('snd-room').value = room;
    S.prefs.sndRoom = room;
    S.prefs.mqttUrl = Phone.cleanUrl($('snd-url').value).slice(0, 200);
    $('snd-url').value = S.prefs.mqttUrl;
    savePrefs();
    if (!Phone.validRoom(room)) { sndStatus('Enter the room code shown on the looper phone (at least ' + Phone.ROOM_MIN + ' letters/digits).', 'err'); return; }
    if (!window.isSecureContext) { sndStatus('The motion sensor needs a secure (https) page.', 'err'); return; }
    if (!('DeviceMotionEvent' in window)) { sndStatus('This browser has no motion sensor support (DeviceMotionEvent).', 'err'); return; }
    S.snd.busy = true;
    // full screen and the iOS motion permission both need the tap: ask for both before the first await
    sndEnterFullscreen(true);
    const perm = typeof DeviceMotionEvent.requestPermission === 'function' ? DeviceMotionEvent.requestPermission() : null;
    sndUi();
    try {
      if (perm) {
        const r = await perm;
        if (r !== 'granted') throw new Error('Motion sensor permission denied.\nAllow "Motion & Orientation Access" for this site and try again.');
      }
      S.snd.active = true;
      S.snd.seen = false;
      S.snd.noData = false;
      S.snd.sent = 0;
      S.snd.peak = 0;
      S.snd.shotPeak = 0; S.snd.shotUntil = 0;
      $('snd-peak').textContent = 'Last peak: –';
      S.snd.det = Phone.MotionDetector({ threshold: S.prefs.motionThr, minGapMs: 1000 });
      window.addEventListener('devicemotion', onDeviceMotion, { passive: true });
      sndAcquireWake();
      sndStatus('Connecting…');
      sndConnect();
      sndLock(true);
      setTimeout(() => {
        if (S.snd.active && !S.snd.seen) {
          S.snd.noData = true;
          sndStatus('No data from the motion sensor.\nThis device/browser may have no accelerometer (PC). "Send test" still works.', 'err');
          sndUi();
        }
      }, 3000);
    } catch (e) {
      log('sender start failed', e && e.message);
      stopSender((e && e.message) || 'Could not start.', 'err');
    } finally {
      S.snd.busy = false;
      sndUi();
    }
  }

  async function sndConnect() {
    if (!S.snd.active || S.snd.client) return;
    clearTimeout(S.snd.retryTimer);
    const room = S.prefs.sndRoom;
    let client = null;
    try {
      client = await Phone.connect({
        url: S.prefs.mqttUrl,
        subscribe: Phone.cfgTopicFor(room),
        onMessage: onSenderConfig,
        onClose: (reason) => {
          if (S.snd.client !== client) return;
          S.snd.client = null;
          log('sender connection closed:', reason);
          sndUi();
          if (!S.snd.active) return;
          sndStatus('Connection lost, reconnecting…', 'err');
          S.snd.retryTimer = setTimeout(sndConnect, 3000);
        }
      });
      if (!S.snd.active || room !== S.prefs.sndRoom) { client.close(); return; }
      S.snd.client = client;
      log('sender connected, room', room);
      sndStatus('Connected, room ' + room + '.\nWaiting for motion…', 'ok');
    } catch (e) {
      log('sender connect failed', e && e.message);
      if (!S.snd.active) return;
      sndStatus('Not connected: ' + (e && e.message) + '\nRetrying…', 'err');
      S.snd.retryTimer = setTimeout(sndConnect, 4000);
    } finally {
      sndUi();
    }
  }

  // threshold set on the looper phone (⚙ → Phone trigger → Sensor threshold)
  function onSenderConfig(topic, payload) {
    if (topic !== Phone.cfgTopicFor(S.prefs.sndRoom)) return;
    const m = Phone.parseConfig(payload);
    log('sender config rx', JSON.stringify(payload).slice(0, 120));
    if (!m) return;
    const thr = Core.clamp(Math.round(m.thr * 2) / 2, MOTION_MIN, MOTION_MAX);
    if (thr === S.prefs.motionThr) return;
    S.prefs.motionThr = thr;
    if (S.snd.det) S.snd.det.threshold = thr;
    savePrefs();
    sndUi();
    sndStatus('Threshold set from the looper device: ' + thr.toFixed(1) + ' m/s²', 'ok');
  }

  // a change made on this sensor phone is shared too, so the looper shows it and does not undo it
  function sndShareThr() {
    const c = S.snd.client;
    if (!c || !Phone.validRoom(S.prefs.sndRoom)) return;
    c.publish(Phone.cfgTopicFor(S.prefs.sndRoom), Phone.cfgPayload(S.prefs.motionThr), true);
    log('sender threshold shared', S.prefs.motionThr);
  }

  function sndSend(a, test) {
    const c = S.snd.client;
    const t = new Date().toLocaleTimeString();
    if (c && c.publish(Phone.topicFor(S.prefs.sndRoom), Phone.motPayload(a))) {
      S.snd.sent++;
      sndFlash();
      log('sender MOT', a.toFixed(2), test ? '(test)' : '');
      sndStatus((test ? 'Test MOT sent' : 'MOT sent') + ' · ' + a.toFixed(1) + ' m/s² · ' + t + '\n(' + S.snd.sent + ' sent)', 'ok');
      return true;
    }
    sndStatus('Movement detected, but not connected: MOT not sent (' + t + ').', 'err');
    return false;
  }

  function onDeviceMotion(e) {
    if (!S.snd.active || !S.snd.det) return;
    const now = performance.now();
    const r = S.snd.det.sample(e.acceleration, e.accelerationIncludingGravity, now);
    if (!r) return;
    if (!S.snd.seen) { S.snd.seen = true; S.snd.noData = false; sndUi(); if (S.snd.client) sndStatus('Connected, room ' + S.prefs.sndRoom + '.\nWaiting for motion…', 'ok'); }
    S.snd.peak = Math.max(r.level, S.snd.peak * 0.9);
    if (r.fire) { S.snd.shotPeak = r.level; S.snd.shotUntil = now + 1000; sndSend(r.level, false); }
    else if (now < S.snd.shotUntil && r.level > S.snd.shotPeak) S.snd.shotPeak = r.level;
    if (S.snd.shotUntil && now >= S.snd.shotUntil) { // highest level within 1 s after the trigger
      S.snd.shotUntil = 0;
      $('snd-peak').textContent = 'Last peak: ' + S.snd.shotPeak.toFixed(1) + ' m/s² (threshold ' + S.prefs.motionThr.toFixed(1) + ')';
      log('sender shot peak', S.snd.shotPeak.toFixed(1));
      const c = S.snd.client;
      if (c) c.publish(Phone.topicFor(S.prefs.sndRoom), Phone.peakPayload(S.snd.shotPeak));
    }
    if (now - S.snd.uiAt > 80) { // the sensor may run at 60-100 Hz: keep the UI light
      S.snd.uiAt = now;
      $('snd-level').textContent = 'Motion: ' + r.level.toFixed(1) + ' m/s²';
      $('snd-fill').style.width = Core.clamp(S.snd.peak / (S.prefs.motionThr * 1.8), 0, 1) * 100 + '%';
    }
  }

  function stopSender(msg, kind) {
    S.snd.active = false;
    sndLock(false);
    sndExitFullscreen();
    window.removeEventListener('devicemotion', onDeviceMotion);
    clearTimeout(S.snd.retryTimer);
    const c = S.snd.client;
    S.snd.client = null;
    try { if (c) c.close(); } catch (e) { /* ignore */ }
    try { if (S.snd.wake) S.snd.wake.release().catch(() => {}); } catch (e) { /* ignore */ }
    S.snd.wake = null;
    S.snd.det = null;
    $('snd-fill').style.width = '0%';
    $('snd-level').textContent = 'Motion: – m/s²';
    if (msg !== undefined) sndStatus(msg || 'Stopped.', kind);
    sndUi();
  }

  // ---- lifecycle -----------------------------------------------------------
  async function acquireWake() {
    try {
      if ('wakeLock' in navigator && !S.wake) {
        S.wake = await navigator.wakeLock.request('screen');
        S.wake.addEventListener('release', () => { S.wake = null; });
      }
    } catch (e) { log('wake lock unavailable', e && e.message); }
  }

  async function startApp() {
    if (S.running || S.starting) return;
    S.starting = true;
    const gen = ++S.gen;
    $('start-msg').textContent = '';
    $('btn-start').disabled = true;
    try {
      // Create + unlock the AudioContext right inside the tap, before any await.
      const AC0 = window.AudioContext || window.webkitAudioContext;
      if (AC0 && S.prefs.input === 'mic') {
        try { S.ctx = new AC0({ latencyHint: 'interactive' }); S.ctx.resume().catch(() => {}); }
        catch (e) { log('AudioContext create failed', e && e.message); S.ctx = null; }
      }
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('Camera access needs a secure (https) page.\nOpen the app from its https:// address.'), { friendly: true });
      }
      if (!('VideoEncoder' in window) || !('VideoFrame' in window)) {
        throw Object.assign(new Error('This browser has no WebCodecs support.\nUse Chrome/Edge 94+ or Safari 16.4+ (iOS 16.4+).'), { friendly: true });
      }
      // fullscreen needs the user gesture: do it first
      try {
        const de = document.documentElement;
        if (de.requestFullscreen && !document.fullscreenElement) await de.requestFullscreen({ navigationUI: 'hide' });
      } catch (e) { /* not available, fine */ }
      applyOrientation(false); // saved choice: landscape (default) or portrait

      S.stream = await openMedia(S.prefs.input === 'mic');
      if (S.gen !== gen) { S.stream.getTracks().forEach((t) => t.stop()); return; }
      const vt = S.stream.getVideoTracks()[0];
      if (!vt) throw Object.assign(new Error('No camera track available.'), { friendly: true });
      S.camId = null;
      const st = vt.getSettings ? vt.getSettings() : {};
      S.camId = st.deviceId || null;
      log('camera settings', JSON.stringify({ w: st.width, h: st.height, fps: st.frameRate, facing: st.facingMode, label: vt.label }));
      noteTrack(vt);
      vt.addEventListener('ended', () => {
        if (S.gen === gen && S.vTrack === vt && S.running && !S.switching) stopAll('Camera was disconnected or taken by another app.\nPress START to try again.');
      });

      S.live.srcObject = new MediaStream([vt]);
      await S.live.play().catch((e) => log('preview play failed', e && e.message));

      if (S.prefs.input === 'mic') await setupAudio(gen);
      if (S.gen !== gen) return;

      stopVideoPipeline(false); // clean state + new video generation
      S.running = true;
      startVideoPipeline(vt);

      acquireWake();
      S.timers.push(setInterval(tick, 200));
      setMode('live');
      updateArming();
      refreshCameras();
      if (S.prefs.input === 'bt') btConnect(false);
      if (S.prefs.input === 'phone') phoneConnect();
      if (navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
      }
    } catch (e) {
      log('start failed:', e && (e.message || e.name));
      if (S.gen === gen) await stopAll(e && e.friendly ? e.message : explainMediaError(e, 'Camera/microphone'));
    } finally {
      S.starting = false;
      $('btn-start').disabled = false;
    }
  }

  function onDeviceChange() { if (S.running && S.panelOpen) refreshCameras(); }

  function tick() {
    if (!S.running) return;
    if (S.ctx && S.ctx.state === 'suspended') S.ctx.resume().catch(() => {});
    S.micOk = S.prefs.input === 'mic' && !!S.ctx && S.ctx.state === 'running' && !!S.stream && S.stream.getAudioTracks().some((t) => t.readyState === 'live');
    updateArming();
    updateStatus();
  }

  async function stopAll(msg) {
    S.gen++;
    S.vgen++;
    S.running = false;
    S.starting = false;
    S.switching = false;
    S.capturing = false;
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* ignore */ }
    S.timers.forEach((t) => clearInterval(t));
    S.timers = [];
    S.calib = null;
    btDisconnect();
    phoneDisconnect();
    S.panelOpen = false;
    S.micStarting = false;
    show('panel', false);
    show('banner', false);
    show('grid', false);
    try { if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener) navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange); } catch (e) { /* ignore */ }
    try { if (S.reader) await S.reader.cancel(); } catch (e) { /* ignore */ }
    S.reader = null;
    try { if (S.encoder && S.encoder.state !== 'closed') S.encoder.close(); } catch (e) { /* ignore */ }
    S.encoder = null; S.encInit = null; S.avcC = null; S.ring = [];
    try { if (S.node) { S.node.port.postMessage({ armed: false }); S.node.port.onmessage = null; S.node.disconnect(); } } catch (e) { /* ignore */ }
    try { if (S.srcNode) S.srcNode.disconnect(); } catch (e) { /* ignore */ }
    try { if (S.gainNode) S.gainNode.disconnect(); } catch (e) { /* ignore */ }
    S.node = null; S.srcNode = null; S.gainNode = null; S.armedPosted = false; S.micOk = false;
    try { if (S.ctx && S.ctx.state !== 'closed') await S.ctx.close(); } catch (e) { /* ignore */ }
    S.ctx = null;
    try { if (S.stream) S.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { if (S.vTrack) S.vTrack.stop(); } catch (e) { /* ignore */ }
    S.stream = null; S.vTrack = null;
    S.live.srcObject = null;
    try { if (Pose) Pose.stop(); } catch (e) { /* ignore */ }
    discardClip();
    try { if (S.wake) await S.wake.release(); } catch (e) { /* ignore */ }
    S.wake = null;
    try { if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen(); } catch (e) { /* ignore */ }
    setMode('idle');
    $('start-msg').textContent = msg || '';
    log('stopped');
  }

  async function exitApp() {
    await stopAll('Stopped. Camera and microphone are off.\nYou can close this app.');
    try { window.close(); } catch (e) { /* not allowed for normal tabs */ }
  }

  // ---- wiring --------------------------------------------------------------
  function init() {
    loadSettings();
    setupGestures();

    $('btn-start').addEventListener('click', startApp);
    $('btn-start-phone').addEventListener('click', () => {
      if (S.running || S.starting) return;
      S.prefs.input = 'phone';
      savePrefs();
      refreshSettingsUi();
      startApp();
    });
    $('btn-exit-live').addEventListener('click', exitApp);
    $('btn-exit-play').addEventListener('click', exitApp);
    $('btn-settings').addEventListener('click', openPanel);
    $('btn-panel-close').addEventListener('click', closePanel);
    $('btn-calib').addEventListener('click', startCalibration);
    $('btn-calib-cancel').addEventListener('click', cancelCalibration);
    $('btn-save').addEventListener('click', onSave);
    $('btn-next').addEventListener('click', onNext);
    $('btn-slomo').addEventListener('click', onSlomo);
    $('slomo-slider').addEventListener('input', (e) => {
      S.prefs.slomoFps = Core.clamp(Math.round(parseFloat(e.target.value) || SLOMO_DEFAULT), SLOMO_MIN, SLOMO_MAX);
      savePrefs();
      refreshSettingsUi();
      updateSlomoButton();
      if (S.slomo && S.slomoTimer) startSlomoLoop(); // new speed applies immediately
      log('slomo speed', S.prefs.slomoFps + ' fps');
    });
    $('btn-zoom-reset').addEventListener('click', resetZoom);
    $('btn-debug').addEventListener('click', () => {
      const el = $('debug-log');
      el.classList.toggle('hidden');
      const open = !el.classList.contains('hidden');
      $('panel-box').classList.toggle('debug-open', open); // the log takes the whole window
      show('btn-debug-copy', open);
      if (open) renderDebug();
    });
    $('btn-debug-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(logs.join('\n')); toast('Log copied', 'ok', 1500); }
      catch (e) { toast('Copy not possible: select the text by hand', 'err', 2500); }
    });

    // trigger input
    $('in-mic').addEventListener('click', () => setInput('mic'));
    $('in-bt').addEventListener('click', () => setInput('bt'));
    $('bt-name').addEventListener('change', commitBtName);
    $('bt-name').addEventListener('blur', commitBtName);
    $('btn-bt-connect').addEventListener('click', () => {
      if (S.bt.state === 'connected') btDisconnect();
      btConnect(true);
    });
    $('btn-bt-hud').addEventListener('click', () => btConnect(true));
    $('in-phone').addEventListener('click', () => setInput('phone'));
    $('in-ai').addEventListener('click', () => setInput('ai'));

    // pose estimation / AI_trig
    $('pose-on').addEventListener('change', (e) => { S.prefs.poseOn = !!e.target.checked; savePrefs(); applyPose(); refreshSettingsUi(); log('pose overlay', S.prefs.poseOn ? 'on' : 'off'); });
    ['wrist', 'elbow', 'both'].forEach((m) => $('ai-m-' + m).addEventListener('click', () => { S.prefs.aiMode = m; savePrefs(); applyPoseConfig(); refreshSettingsUi(); log('AI release from', m); }));
    ['mouth', 'nose'].forEach((m) => $('ai-r-' + m).addEventListener('click', () => { S.prefs.aiRef = m; savePrefs(); applyPoseConfig(); refreshSettingsUi(); log('AI distance measured from', m); }));
    $('ai-thr').addEventListener('input', (e) => { S.prefs.aiThr = Core.clamp(Math.round((parseFloat(e.target.value) || 2) * 10) / 10, 0.5, 4); savePrefs(); applyPoseConfig(); refreshSettingsUi(); });
    $('pose-log-on').addEventListener('change', (e) => { S.prefs.poseLog = !!e.target.checked; savePrefs(); refreshSettingsUi(); log('pose log', S.prefs.poseLog ? 'on' : 'off'); });
    $('btn-pose-clear').addEventListener('click', () => { Pose.clearLog(); refreshSettingsUi(); });
    $('btn-pose-dl').addEventListener('click', () => {
      try {
        const blob = new Blob([Pose.exportLog()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'pose_log_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast('Pose log downloaded (' + Pose.logInfo() + ')', 'ok', 2500);
      } catch (err) { toast('Download failed: ' + (err && err.message), 'err', 3000); }
    });
    // a detected release acts like a mic / BT / PHONE signal (same lockout, Sync offset, AUTO MODE rules)
    if (Pose) Pose.onEvent((ev) => {
      log('AI pose event', ev.type);
      if (S.prefs.input !== 'ai') return;
      // full draw while a clip is playing: stop the replay and show the live view (the release then records the new shot)
      if (ev.type === 'full_draw' && S.mode === 'playback' && !S.capturing && !S.saving && !S.sharing) {
        log('AI full draw: back to live');
        discardClip();
        returnToLive();
        return;
      }
      if (ev.type === 'release') onRemoteSignal('ai', S.ai);
    });
    $('ph-room').addEventListener('change', commitRoom);
    $('ph-room').addEventListener('blur', commitRoom);
    $('ph-url').addEventListener('change', commitMqttUrl);
    $('ph-url').addEventListener('blur', commitMqttUrl);
    $('btn-ph-url-reset').addEventListener('click', () => { $('ph-url').value = Phone.DEFAULT_URL; commitMqttUrl(); toast('Default server restored', 'ok', 1800); });
    $('btn-ph-copy').addEventListener('click', copyRoom);
    $('ph-sthr').addEventListener('input', (e) => { $('ph-sthr-text').textContent = (Math.round(parseFloat(e.target.value) * 2) / 2).toFixed(1) + ' m/s²'; });
    $('ph-sthr').addEventListener('change', (e) => setSensorThr(e.target.value, true));
    $('btn-ph-sthr-reset').addEventListener('click', () => setSensorThr(MOTION_DEFAULT, true));
    $('btn-ph-new').addEventListener('click', () => {
      S.prefs.room = Phone.randomRoom();
      savePrefs();
      log('phone room', S.prefs.room, '(new)');
      refreshSettingsUi();
      updateTopbar();
      phoneReconnect();
      toast('New room code: ' + S.prefs.room + '\nEnter it on the MOTION SENDER phone.', null, 3500);
    });
    $('btn-ph-connect').addEventListener('click', () => {
      if (S.prefs.input !== 'phone') setInput('phone');
      else if (S.ph.want) phoneDisconnect();
      else phoneReconnect();
      updateStatus();
    });

    // MOTION SENDER screen
    $('btn-sender').addEventListener('click', openSender);
    $('btn-snd-back').addEventListener('click', closeSender);
    $('btn-snd-start').addEventListener('click', startSender);
    $('btn-snd-stop').addEventListener('click', () => stopSender('Stopped.'));
    $('btn-snd-test').addEventListener('click', () => sndSend(S.prefs.motionThr, true));
    $('btn-snd-hide').addEventListener('click', () => sndLock(true));
    $('btn-snd-url-reset').addEventListener('click', () => {
      $('snd-url').value = S.prefs.mqttUrl = Phone.DEFAULT_URL;
      savePrefs();
      sndStatus('Default server restored.', 'ok');
    });
    setupSenderLock();
    $('snd-room').addEventListener('input', () => { const v = Phone.cleanRoom($('snd-room').value); if (v !== $('snd-room').value) $('snd-room').value = v; });
    $('snd-thr').addEventListener('input', (e) => {
      S.prefs.motionThr = Core.clamp(Math.round((parseFloat(e.target.value) || MOTION_DEFAULT) * 2) / 2, MOTION_MIN, MOTION_MAX);
      if (S.snd.det) S.snd.det.threshold = S.prefs.motionThr;
      savePrefs();
      sndUi();
    });
    $('snd-thr').addEventListener('change', sndShareThr);

    // microphone
    $('thr-slider').addEventListener('input', (e) => applyThreshold(Core.fromDb(parseFloat(e.target.value)), true));
    $('off-slider').addEventListener('input', (e) => {
      S.offsetMs = parseFloat(e.target.value) || 0;
      $('off-text').textContent = String(Math.round(S.offsetMs));
      try { localStorage.setItem(LS_OFF, String(S.offsetMs)); } catch (err) { /* ignore */ }
    });

    // camera
    $('cam-select').addEventListener('change', (e) => switchCamera(e.target.value));
    $('btn-cam-flip').addEventListener('click', flipCamera);
    $('fps-30').addEventListener('click', () => setFps(30));
    $('fps-60').addEventListener('click', () => setFps(60));

    // clip / buffer length
    $('buf-slider').addEventListener('input', (e) => {
      S.prefs.buf = Core.clamp(Math.round((parseFloat(e.target.value) || 2) * 2) / 2, BUF_MIN, BUF_MAX);
      savePrefs();
      refreshSettingsUi();
      updateArming();
      log('clip length', S.prefs.buf + ' s');
    });

    // before / after the signal (seconds before; the rest of the length is after)
    $('split-slider').addEventListener('input', (e) => {
      const pre = Core.clamp(parseFloat(e.target.value) || 0, 0, S.prefs.buf);
      S.prefs.split = S.prefs.buf > 0 ? pre / S.prefs.buf : 0.5;
      savePrefs();
      refreshSettingsUi();
      updateArming();
      log('clip split', preSec() + ' s before /', fmt(S.prefs.buf - preSec()) + ' s after');
    });

    // AUTO MODE
    $('auto-on').addEventListener('change', (e) => {
      S.prefs.auto = !!e.target.checked;
      savePrefs();
      updateStatus();
      log('auto mode', S.prefs.auto ? 'on' : 'off');
    });

    // screen orientation
    $('ori-landscape').addEventListener('click', () => setOrientation('landscape'));
    $('ori-portrait').addEventListener('click', () => setOrientation('portrait'));

    // zoom
    $('zoom-on').addEventListener('change', (e) => {
      S.prefs.zoomOn = !!e.target.checked;
      savePrefs();
      if (!S.prefs.zoomOn) resetZoom(); // switching zoom off also clears any zoom
      log('zoom', S.prefs.zoomOn ? 'on' : 'off');
    });

    // grid
    $('grid-on').addEventListener('change', (e) => { S.prefs.gridOn = !!e.target.checked; savePrefs(); applyGrid(); });
    $('grid-size').addEventListener('input', (e) => {
      S.prefs.gridSize = Core.clamp(Math.round(parseFloat(e.target.value) || 100), GRID_MIN, GRID_MAX);
      savePrefs(); refreshSettingsUi(); applyGrid();
    });
    $('grid-int').addEventListener('input', (e) => {
      S.prefs.gridInt = Core.clamp(Math.round(parseFloat(e.target.value) || 5), 1, 10);
      savePrefs(); refreshSettingsUi(); applyGrid();
    });
    Object.keys(GRID_COLORS).forEach((c) => {
      $('gc-' + c).addEventListener('click', () => { S.prefs.gridColor = c; savePrefs(); refreshSettingsUi(); applyGrid(); });
    });

    window.addEventListener('resize', () => { applyGrid(); applyZoom(); });

    // Lifecycle: browsers stop camera/mic when the page is hidden, so shut down cleanly.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && S.snd.active) sndAcquireWake(); // the wake lock is dropped while hidden
      if (document.visibilityState === 'hidden' && S.running && !S.sharing) {
        log('page hidden -> stopping');
        stopAll('Paused because the app went to the background.\nPress START to continue.');
      }
    });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch((e) => log('sw register failed', e && e.message));
    }
    setMode('idle');
    log('DD Archery Looper v6 ready. secure=' + window.isSecureContext + ' ios=' + isIOS +
      ' webcodecs=' + ('VideoEncoder' in window) + ' trackProcessor=' + ('MediaStreamTrackProcessor' in window));
  }

  init();
})();
