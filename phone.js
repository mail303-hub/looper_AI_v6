/*
 * PHONE trigger: a second phone sends "MOT" over MQTT (MQTT 3.1.1 over a secure WebSocket).
 * Hand-written packets, no libraries. Only QoS 0, one topic per room:
 *   ddarchery/v1/<ROOM>/trigger   payload {"type":"MOT","a":<m/s²>,"ts":<ms>}
 * Also: room codes and the motion detector used by the MOTION SENDER screen.
 */
(function (root) {
  'use strict';

  const DEFAULT_URL = 'wss://broker.emqx.io:8084/mqtt';
  const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  const ROOM_MIN = 6, ROOM_MAX = 16, ROOM_LEN = 8;
  const KEEPALIVE_S = 30;

  // ---- room codes ------------------------------------------------------------
  function cleanRoom(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_MAX); }
  function validRoom(v) { return cleanRoom(v).length >= ROOM_MIN; }
  function randomRoom(n) {
    const b = new Uint8Array(n || ROOM_LEN);
    root.crypto.getRandomValues(b);
    return Array.from(b, (x) => ROOM_CHARS[x % ROOM_CHARS.length]).join('');
  }
  function topicFor(room) { return 'ddarchery/v1/' + room + '/trigger'; }
  // sensor settings shared by the looper and the sensor phone (retained: whoever connects gets the last change)
  function cfgTopicFor(room) { return 'ddarchery/v1/' + room + '/config'; }
  function cleanUrl(v) { const u = String(v || '').trim(); return u || DEFAULT_URL; }

  // ---- MQTT packets ------------------------------------------------------------
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function encLen(n) {
    const out = [];
    do {
      let d = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) d |= 128;
      out.push(d);
    } while (n > 0);
    return out;
  }
  function str(s) { const b = enc.encode(String(s)); return [b.length >> 8, b.length & 255].concat(Array.from(b)); }
  function packet(head, body) { return new Uint8Array([head].concat(encLen(body.length), body)); }

  function connectPacket(clientId, keepAlive) {
    const ka = keepAlive || KEEPALIVE_S;
    // protocol "MQTT", level 4 (3.1.1), flags: clean session
    return packet(0x10, [0, 4, 77, 81, 84, 84, 4, 0x02, ka >> 8, ka & 255].concat(str(clientId)));
  }
  // one topic or a list of topics, QoS 0 each
  function subscribePacket(id, topics) {
    let body = [id >> 8, id & 255];
    [].concat(topics).forEach((t) => { body = body.concat(str(t), [0]); });
    return packet(0x82, body);
  }
  function publishPacket(topic, payload, retain) { return packet(retain ? 0x31 : 0x30, str(topic).concat(Array.from(enc.encode(String(payload))))); }
  const PINGREQ = new Uint8Array([0xC0, 0]);
  const DISCONNECT = new Uint8Array([0xE0, 0]);

  // Stream parser: a WebSocket frame may hold several MQTT packets, or a part of one.
  function Parser() {
    let buf = new Uint8Array(0);
    return {
      feed(chunk) {
        const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        const nb = new Uint8Array(buf.length + c.length);
        nb.set(buf); nb.set(c, buf.length);
        buf = nb;
        const out = [];
        for (;;) {
          if (buf.length < 2) break;
          let i = 1, mult = 1, len = 0, d, ok = false;
          while (i < buf.length && i <= 4) {
            d = buf[i++];
            len += (d & 127) * mult;
            mult *= 128;
            if (!(d & 128)) { ok = true; break; }
          }
          if (!ok) { if (i > 4) throw new Error('bad MQTT length'); break; }
          if (buf.length < i + len) break;
          out.push({ type: buf[0] & 0xF0, flags: buf[0] & 0x0F, body: buf.slice(i, i + len) });
          buf = buf.slice(i + len);
        }
        return out;
      }
    };
  }

  function parsePublish(p) {
    const b = p.body;
    if (b.length < 2) return null;
    const n = (b[0] << 8) | b[1];
    let i = 2 + n;
    if (i > b.length) return null;
    const topic = dec.decode(b.slice(2, i));
    if ((p.flags >> 1) & 3) i += 2; // QoS > 0: packet id
    return { topic: topic, payload: dec.decode(b.slice(i)) };
  }

  /*
   * Connects and (optionally) subscribes. Resolves with a client once ready.
   * opts: { url, subscribe: topic|[topics]|null, onMessage(topic, payload), onClose(reason), timeoutMs, WebSocket }
   */
  function connect(opts) {
    const WS = opts.WebSocket || root.WebSocket;
    const url = cleanUrl(opts.url);
    return new Promise((resolve, reject) => {
      if (!/^wss?:\/\//i.test(url)) { reject(new Error('Server address must start with wss://')); return; }
      let ws, settled = false, closed = false, pingTimer = 0, lastRx = Date.now(), subId = 0;
      const parser = Parser();
      const timer = setTimeout(() => fail(new Error('Server did not answer (timeout). Check the internet connection / server.')), opts.timeoutMs || 12000);

      const client = {
        url: url,
        get open() { return !closed && ws && ws.readyState === 1; },
        publish(topic, payload, retain) {
          if (!client.open) return false;
          try { ws.send(publishPacket(topic, payload, retain)); return true; } catch (e) { return false; }
        },
        close() { shut('closed'); }
      };

      function shut(reason) {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearInterval(pingTimer);
        try { if (ws && ws.readyState === 1) ws.send(DISCONNECT); } catch (e) { /* ignore */ }
        try { if (ws) ws.close(); } catch (e) { /* ignore */ }
        if (settled && opts.onClose) { try { opts.onClose(reason); } catch (e) { /* ignore */ } }
      }
      function fail(err) {
        if (!settled) { shut(''); settled = true; reject(err); } else shut(err && err.message); // onClose only after a successful connect
      }
      function ready() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // keepalive: ping every 15 s; no packet from the server for 2 x keepalive = dead connection
        pingTimer = setInterval(() => {
          if (Date.now() - lastRx > KEEPALIVE_S * 2000) { shut('no answer from server'); return; }
          try { ws.send(PINGREQ); } catch (e) { shut('send failed'); }
        }, 15000);
        resolve(client);
      }

      try { ws = new WS(url, 'mqtt'); } catch (e) { fail(e); return; }
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const cid = 'ddal_' + Math.random().toString(36).slice(2, 12);
        try { ws.send(connectPacket(cid, KEEPALIVE_S)); } catch (e) { fail(e); }
      };
      ws.onmessage = async (ev) => {
        let data = ev.data;
        if (data && typeof data.arrayBuffer === 'function' && !(data instanceof ArrayBuffer)) data = await data.arrayBuffer();
        if (typeof data === 'string') return;
        lastRx = Date.now();
        let pkts;
        try { pkts = parser.feed(new Uint8Array(data)); } catch (e) { fail(e); return; }
        for (const p of pkts) {
          if (p.type === 0x20) { // CONNACK
            if (p.body.length < 2 || p.body[1] !== 0) { fail(new Error('Server refused the connection (code ' + p.body[1] + ').')); return; }
            if (opts.subscribe) { subId = 1; ws.send(subscribePacket(subId, opts.subscribe)); } else ready();
          } else if (p.type === 0x90) { // SUBACK
            if (p.body.length >= 3 && Array.from(p.body.slice(2)).indexOf(0x80) >= 0) { fail(new Error('Server refused the subscription.')); return; }
            ready();
          } else if (p.type === 0x30) { // PUBLISH
            const m = parsePublish(p);
            if (m && opts.onMessage) { try { opts.onMessage(m.topic, m.payload); } catch (e) { /* ignore */ } }
          }
          // PINGRESP (0xD0): only refreshes lastRx
        }
      };
      ws.onerror = () => { if (!settled) fail(new Error('WebSocket connection failed (' + url + ').')); };
      ws.onclose = () => { if (!settled) fail(new Error('Connection closed by the server.')); else shut('connection lost'); };
    });
  }

  // ---- trigger message ---------------------------------------------------------
  function motPayload(a) { return JSON.stringify({ type: 'MOT', a: Math.round(a * 100) / 100, ts: Date.now() }); }
  // JSON {"type":"MOT",...} or plain text containing MOT (e.g. from a microcontroller). Returns {a} or null.
  // after a trigger the sensor reports the highest level of that shot: {"type":"PEAK","p":<m/s²>}
  function peakPayload(p) { return JSON.stringify({ type: 'PEAK', p: Math.round(p * 10) / 10 }); }
  function parsePeak(payload) {
    try {
      const m = JSON.parse(String(payload || ''));
      if (m && String(m.type).toUpperCase() === 'PEAK' && typeof m.p === 'number' && isFinite(m.p)) return { p: m.p };
    } catch (e) { /* not JSON */ }
    return null;
  }
  function parseTrigger(payload) {
    const t = String(payload || '');
    try {
      const m = JSON.parse(t);
      if (m && typeof m === 'object') return String(m.type).toUpperCase() === 'MOT' ? { a: isFinite(m.a) ? +m.a : null } : null;
    } catch (e) { /* not JSON */ }
    return /MOT/i.test(t) ? { a: null } : null;
  }

  // ---- sensor settings sent by the looper ---------------------------------------
  function cfgPayload(thr) { return JSON.stringify({ type: 'CFG', thr: Math.round(thr * 2) / 2 }); }
  // {"type":"CFG","thr":<m/s²>} -> {thr} or null
  function parseConfig(payload) {
    try {
      const m = JSON.parse(String(payload || ''));
      if (m && String(m.type).toUpperCase() === 'CFG' && typeof m.thr === 'number' && isFinite(m.thr)) return { thr: m.thr };
    } catch (e) { /* not JSON */ }
    return null;
  }

  // ---- motion detector (MOTION SENDER) -----------------------------------------
  // Linear acceleration level (m/s², gravity removed). Fires once when the level reaches the threshold,
  // then re-arms after it fell below 60 % of the threshold and at least minGapMs passed.
  function MotionDetector(o) {
    const d = {
      threshold: (o && o.threshold) || 15,
      minGapMs: (o && o.minGapMs) || 1000,
      above: false, lastFire: -Infinity, g: null,
      reset() { d.above = false; d.lastFire = -Infinity; d.g = null; },
      // acc = event.acceleration, accG = event.accelerationIncludingGravity; null when the event has no data
      sample(acc, accG, now) {
        let x, y, z;
        const fin = (v) => !!v && [v.x, v.y, v.z].every((n) => typeof n === 'number' && isFinite(n));
        if (fin(acc)) { x = acc.x; y = acc.y; z = acc.z; }
        else if (fin(accG)) {
          // no linear acceleration on this device: remove gravity with a slow low-pass filter
          if (!d.g) d.g = { x: accG.x, y: accG.y, z: accG.z };
          x = accG.x - d.g.x; y = accG.y - d.g.y; z = accG.z - d.g.z;
          const k = 0.08;
          d.g.x += k * (accG.x - d.g.x); d.g.y += k * (accG.y - d.g.y); d.g.z += k * (accG.z - d.g.z);
        } else return null;
        const level = Math.sqrt(x * x + y * y + z * z);
        if (level < d.threshold * 0.6) d.above = false;
        let fire = false;
        if (level >= d.threshold && !d.above && now - d.lastFire >= d.minGapMs) {
          d.above = true; d.lastFire = now; fire = true;
        }
        return { level: level, fire: fire };
      }
    };
    return d;
  }

  const api = {
    DEFAULT_URL, ROOM_MIN, ROOM_MAX, cleanRoom, validRoom, randomRoom, topicFor, cfgTopicFor, cleanUrl,
    encLen, connectPacket, subscribePacket, publishPacket, Parser, parsePublish, connect,
    motPayload, parseTrigger, peakPayload, parsePeak, cfgPayload, parseConfig, MotionDetector
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DDPhone = api;
})(typeof self !== 'undefined' ? self : globalThis);
