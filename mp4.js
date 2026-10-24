/*
 * Minimal MP4 (ISO BMFF) muxer for a single H.264 video track.
 * Input samples are AVCC (length-prefixed) access units as produced by
 * WebCodecs VideoEncoder with avc: { format: 'avc' }.
 *
 * Supports an edit list so the visible clip can start exactly at a chosen time
 * even though the first stored sample is the preceding keyframe.
 */
(function (root) {
  'use strict';

  const MEDIA_TS = 90000; // media timescale
  const MOVIE_TS = 1000;  // movie timescale (ms)

  function u16(n) { return [(n >>> 8) & 255, n & 255]; }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function str(s) { return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]; }
  function zeros(n) { return new Array(n).fill(0); }

  function toBytes(p) {
    return p instanceof Uint8Array ? p : Uint8Array.from(p);
  }

  function box(type, ...payloads) {
    const parts = payloads.map(toBytes);
    let size = 8;
    for (const p of parts) size += p.length;
    const out = new Uint8Array(size);
    out.set(u32(size), 0);
    out.set(str(type), 4);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function fullBox(type, version, flags, ...payloads) {
    return box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...payloads);
  }

  const MATRIX = [].concat(
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000)
  );

  /**
   * @param {Object} o
   * @param {Array<{data:Uint8Array,key:boolean,t:number}>} o.samples  t in ms, increasing, first sample must be a keyframe
   * @param {number} o.width
   * @param {number} o.height
   * @param {Uint8Array} o.avcC  AVCDecoderConfigurationRecord
   * @param {number} o.editStartMs  how much of the beginning to skip (ms, >= 0)
   * @param {number} o.editDurMs    visible duration (ms)
   * @param {number} [o.lastDurMs]  duration of the last sample (ms)
   * @returns {Uint8Array}
   */
  function buildMp4(o) {
    const samples = o.samples;
    if (!samples || !samples.length) throw new Error('no samples');
    if (!samples[0].key) throw new Error('first sample is not a keyframe');
    if (!o.avcC || !o.avcC.length) throw new Error('missing avcC');

    const n = samples.length;
    const t0 = samples[0].t;

    // Decode timestamps in media timescale (cumulative rounding avoids drift).
    const dts = samples.map(s => Math.round((s.t - t0) * MEDIA_TS / 1000));
    const deltas = new Array(n);
    for (let i = 0; i < n - 1; i++) deltas[i] = Math.max(1, dts[i + 1] - dts[i]);
    const lastMs = o.lastDurMs && o.lastDurMs > 0 ? o.lastDurMs : (n > 1 ? deltas[n - 2] * 1000 / MEDIA_TS : 33.333);
    deltas[n - 1] = Math.max(1, Math.round(lastMs * MEDIA_TS / 1000));
    let mediaDur = 0;
    for (const d of deltas) mediaDur += d;

    const editStart = Math.max(0, Math.round((o.editStartMs || 0) * MEDIA_TS / 1000));
    const editDurMovie = Math.max(1, Math.round(o.editDurMs));

    // stts (run-length)
    const sttsEntries = [];
    for (let i = 0; i < n; i++) {
      const last = sttsEntries[sttsEntries.length - 1];
      if (last && last[1] === deltas[i]) last[0]++;
      else sttsEntries.push([1, deltas[i]]);
    }
    const stts = [];
    for (const e of sttsEntries) stts.push(...u32(e[0]), ...u32(e[1]));

    const keyIdx = [];
    for (let i = 0; i < n; i++) if (samples[i].key) keyIdx.push(i + 1);
    const stss = [];
    for (const k of keyIdx) stss.push(...u32(k));

    const stsz = new Uint8Array(n * 4);
    let dataSize = 0;
    for (let i = 0; i < n; i++) {
      const l = samples[i].data.length;
      stsz.set(u32(l), i * 4);
      dataSize += l;
    }

    const w = o.width, h = o.height;

    function buildMoov(chunkOffset) {
      const avc1 = box('avc1',
        zeros(6), u16(1),            // reserved, data_reference_index
        u16(0), u16(0), zeros(12),   // predefined/reserved
        u16(w), u16(h),
        u32(0x00480000), u32(0x00480000),
        u32(0),
        u16(1),                      // frame_count
        zeros(32),                   // compressorname
        u16(0x0018), u16(0xFFFF),
        box('avcC', o.avcC)
      );
      const stsd = fullBox('stsd', 0, 0, u32(1), avc1);
      const stblBox = box('stbl',
        stsd,
        fullBox('stts', 0, 0, u32(sttsEntries.length), stts),
        fullBox('stss', 0, 0, u32(keyIdx.length), stss),
        fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
        fullBox('stsz', 0, 0, u32(0), u32(n), stsz),
        fullBox('stco', 0, 0, u32(1), u32(chunkOffset))
      );
      const minf = box('minf',
        fullBox('vmhd', 0, 1, u16(0), zeros(6)),
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        stblBox
      );
      const mdia = box('mdia',
        fullBox('mdhd', 0, 0, u32(0), u32(0), u32(MEDIA_TS), u32(mediaDur), u16(0x55C4), u16(0)),
        fullBox('hdlr', 0, 0, u32(0), str('vide'), zeros(12), [...'VideoHandler'].map(c => c.charCodeAt(0)), [0]),
        minf
      );
      const edts = box('edts',
        fullBox('elst', 0, 0, u32(1), u32(editDurMovie), u32(editStart), u32(0x00010000))
      );
      const trak = box('trak',
        fullBox('tkhd', 0, 3,
          u32(0), u32(0), u32(1), u32(0), u32(editDurMovie),
          zeros(8), u16(0), u16(0), u16(0), u16(0),
          MATRIX, u32(w << 16), u32(h << 16)),
        edts,
        mdia
      );
      const mvhd = fullBox('mvhd', 0, 0,
        u32(0), u32(0), u32(MOVIE_TS), u32(editDurMovie),
        u32(0x00010000), u16(0x0100), u16(0), zeros(8),
        MATRIX, zeros(24), u32(2));
      return box('moov', mvhd, trak);
    }

    const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    const moov0 = buildMoov(0);
    const mdatHeader = 8;
    const offset = ftyp.length + moov0.length + mdatHeader;
    const moov = buildMoov(offset);

    const total = ftyp.length + moov.length + mdatHeader + dataSize;
    if (total >= 0xFFFFFFFF) throw new Error('clip too large');
    const out = new Uint8Array(total);
    let p = 0;
    out.set(ftyp, p); p += ftyp.length;
    out.set(moov, p); p += moov.length;
    out.set(u32(dataSize + 8), p); out.set(str('mdat'), p + 4); p += 8;
    for (const s of samples) { out.set(s.data, p); p += s.data.length; }
    return out;
  }

  const api = { buildMp4 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DDMp4 = api;
})(typeof self !== 'undefined' ? self : this);
