'use strict';

/**
 * mp4patcher.js — Binary MP4 Box Manipulator
 * Mode 3: Null-Frame Video Extension
 *
 * Appends N null/empty sample entries to the video track's stts/stsz/stco
 * tables without re-encoding. All null entries share a single 8-byte stub
 * payload appended to mdat. Audio track and all other boxes are untouched
 * (except stco offsets which are shifted to account for the larger moov).
 *
 * Input requirement: moov MUST be before mdat (fast-start / moov-first layout).
 * If moov is at the end, run Mode 2 FastStart Copy first.
 *
 * Based on analysis of:
 *   REF: ftyp→moov(20737B)→free→mdat(1919540B)  video stts: [(784,512)]   stsz:784  stco:563
 *   CMP: ftyp→moov(89329B)→free→mdat(1919548B)   video stts: [(784,512),(8573,1500)]  stsz:9357  stco:9136
 */

const MP4Patcher = (() => {

  // ── Low-level binary I/O ─────────────────────────────────────────────────

  /** Read big-endian uint32 from Uint8Array */
  function r32(b, o) { return ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0; }

  /** Write big-endian uint32 into Uint8Array */
  function w32(b, o, v) {
    v = v>>>0;
    b[o]=(v>>24)&0xFF; b[o+1]=(v>>16)&0xFF; b[o+2]=(v>>8)&0xFF; b[o+3]=v&0xFF;
  }

  /** Read 4-char ASCII box type */
  function r4cc(b, o) { return String.fromCharCode(b[o],b[o+1],b[o+2],b[o+3]); }

  // ── Box navigation ───────────────────────────────────────────────────────

  /** Find first box of given type within byte range [start, end). Returns null if not found. */
  function findBox(buf, start, end, type) {
    let pos = start;
    while (pos + 8 <= end) {
      const size = r32(buf, pos);
      if (size < 8) break;
      const cc = r4cc(buf, pos+4);
      if (cc === type) return { offset: pos, size, end: pos+size, dataOff: pos+8 };
      pos += size;
    }
    return null;
  }

  /** Find ALL boxes of a given type within a byte range. */
  function findAll(buf, start, end, type) {
    const out = [];
    let pos = start;
    while (pos + 8 <= end) {
      const size = r32(buf, pos);
      if (size < 8) break;
      if (r4cc(buf, pos+4) === type) out.push({ offset: pos, size, end: pos+size, dataOff: pos+8 });
      pos += size;
    }
    return out;
  }

  // ── Sample table parsers ─────────────────────────────────────────────────

  /** Parse stts (time-to-sample). Returns [{count, duration}]. */
  function parseStts(buf, box) {
    const n = r32(buf, box.dataOff+4);
    const e = [];
    for (let i=0,p=box.dataOff+8; i<n; i++,p+=8)
      e.push({ count: r32(buf,p), duration: r32(buf,p+4) });
    return e;
  }

  /** Parse stsz (sample size). Returns { uniform, total, sizes[] }. */
  function parseStsz(buf, box) {
    const uniform = r32(buf, box.dataOff+4);
    const total   = r32(buf, box.dataOff+8);
    const sizes = [];
    if (uniform === 0)
      for (let i=0,p=box.dataOff+12; i<total; i++,p+=4) sizes.push(r32(buf,p));
    return { uniform, total, sizes };
  }

  /** Parse stco (chunk offset). Returns number[]. */
  function parseStco(buf, box) {
    const n = r32(buf, box.dataOff+4);
    const a = [];
    for (let i=0,p=box.dataOff+8; i<n; i++,p+=4) a.push(r32(buf,p));
    return a;
  }

  // ── Sample table builders ────────────────────────────────────────────────

  function buildStts(entries) {
    const b = new Uint8Array(8+4+4+entries.length*8);
    w32(b,0,b.length); b[4]=0x73;b[5]=0x74;b[6]=0x74;b[7]=0x73; // 'stts'
    w32(b,8,0); w32(b,12,entries.length);
    for (let i=0,p=16; i<entries.length; i++,p+=8) {
      w32(b,p,entries[i].count); w32(b,p+4,entries[i].duration);
    }
    return b;
  }

  function buildStsz(sizes) {
    const b = new Uint8Array(8+4+4+4+sizes.length*4);
    w32(b,0,b.length); b[4]=0x73;b[5]=0x74;b[6]=0x73;b[7]=0x7A; // 'stsz'
    w32(b,8,0); w32(b,12,0); w32(b,16,sizes.length);
    for (let i=0,p=20; i<sizes.length; i++,p+=4) w32(b,p,sizes[i]);
    return b;
  }

  function buildStco(offsets) {
    const b = new Uint8Array(8+4+4+offsets.length*4);
    w32(b,0,b.length); b[4]=0x73;b[5]=0x74;b[6]=0x63;b[7]=0x6F; // 'stco'
    w32(b,8,0); w32(b,12,offsets.length);
    for (let i=0,p=16; i<offsets.length; i++,p+=4) w32(b,p,offsets[i]);
    return b;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Read video timescale from mdhd box. Handles version 0 and 1. */
  function readTimescale(buf, mdiaBox) {
    const mdhd = findBox(buf, mdiaBox.dataOff, mdiaBox.end, 'mdhd');
    if (!mdhd) return 0;
    const version = buf[mdhd.dataOff];
    // v0: creation(4)+modification(4)+timescale(4)
    // v1: creation(8)+modification(8)+timescale(4)
    const tsOff = version === 1 ? mdhd.dataOff + 16 : mdhd.dataOff + 8;
    return r32(buf, tsOff);
  }

  // ── Main patch entry point ────────────────────────────────────────────────

  /**
   * Patch an MP4 file by appending null video frames to the sample tables.
   *
   * @param {ArrayBuffer} arrayBuffer  Input file bytes
   * @param {number}  nullCount     Number of null frames to append
   * @param {number}  nullDuration  Duration per null frame in timescale ticks (e.g. 1500)
   * @param {number}  nullSize      Byte size for each null frame (shared stub, e.g. 8)
   * @param {Function} onLog        Callback(message, level) for progress logging
   * @returns {ArrayBuffer}  Patched file bytes
   */
  function patch(arrayBuffer, nullCount, nullDuration, nullSize, onLog) {
    const buf = new Uint8Array(arrayBuffer);
    const len = buf.length;

    onLog('Parsing MP4 structure…', 'info');

    // ── 1. Locate top-level boxes ─────────────────────────────────────────
    const ftypBox = findBox(buf, 0, len, 'ftyp');
    if (!ftypBox) throw new Error('No ftyp box — not a valid MP4 file');

    // moov must come BEFORE mdat (fast-start layout)
    const moovBox = findBox(buf, ftypBox.end, len, 'moov');
    const mdatScan = findBox(buf, ftypBox.end, len, 'mdat');
    if (!moovBox) throw new Error('No moov box found');
    if (mdatScan && mdatScan.offset < moovBox.offset)
      throw new Error(
        'moov is AFTER mdat — this is not a fast-start MP4.\n' +
        'Run Mode 2 → FastStart Copy first, then apply Mode 3.'
      );

    const freeBox  = findBox(buf, moovBox.end, len, 'free');
    const mdatBox  = findBox(buf, moovBox.end, len, 'mdat');
    if (!mdatBox) throw new Error('No mdat box found after moov');

    onLog(
      `ftyp @0(${ftypBox.size}B)  moov @${moovBox.offset}(${moovBox.size}B)  mdat @${mdatBox.offset}(${mdatBox.size}B)`,
      'info'
    );

    // ── 2. Identify audio and video tracks ────────────────────────────────
    const traks = findAll(buf, moovBox.dataOff, moovBox.end, 'trak');
    if (!traks.length) throw new Error('No trak boxes found in moov');

    let videoTrak=null, audioTrak=null;
    for (const trak of traks) {
      const mdia = findBox(buf, trak.dataOff, trak.end, 'mdia');
      if (!mdia) continue;
      const hdlr = findBox(buf, mdia.dataOff, mdia.end, 'hdlr');
      if (!hdlr) continue;
      // handler_type: version(1)+flags(3)+pre_defined(4) → +8
      const ht = r4cc(buf, hdlr.dataOff+8);
      if (ht === 'vide') videoTrak = trak;
      else if (ht === 'soun') audioTrak = trak;
    }
    if (!videoTrak) throw new Error('No video track (handler=vide) found');

    // ── 3. Navigate to video stbl ─────────────────────────────────────────
    const vMdia = findBox(buf, videoTrak.dataOff, videoTrak.end, 'mdia');
    const vMinf = findBox(buf, vMdia.dataOff,     vMdia.end,     'minf');
    const vStbl = findBox(buf, vMinf.dataOff,     vMinf.end,     'stbl');
    const vstts = findBox(buf, vStbl.dataOff,     vStbl.end,     'stts');
    const vstsz = findBox(buf, vStbl.dataOff,     vStbl.end,     'stsz');
    const vstco = findBox(buf, vStbl.dataOff,     vStbl.end,     'stco');
    if (!vstts||!vstsz||!vstco)
      throw new Error('Video track is missing stts, stsz, or stco — cannot patch');

    const timescale = readTimescale(buf, vMdia);
    const extSeconds = nullCount * nullDuration / (timescale || 1);
    onLog(
      `Video track: timescale=${timescale}  stts=${vstts.size}B  stsz=${vstsz.size}B  stco=${vstco.size}B`,
      'info'
    );
    onLog(
      `Appending ${nullCount} null frames × ${nullDuration} ticks = +${extSeconds.toFixed(1)}s media time`,
      'info'
    );

    // ── 4. Parse existing sample tables ───────────────────────────────────
    const sttsEntries = parseStts(buf, vstts);
    const stszData    = parseStsz(buf, vstsz);
    const vstcoOffs   = parseStco(buf, vstco);

    onLog(
      `stts: ${sttsEntries.length} entries  stsz: ${stszData.total} samples  stco: ${vstcoOffs.length} chunks`,
      'info'
    );

    // ── 5. Build new video sample tables ──────────────────────────────────
    const newSttsEntries = [...sttsEntries, { count: nullCount, duration: nullDuration }];

    let existSizes = stszData.sizes;
    if (stszData.uniform > 0) existSizes = Array(stszData.total).fill(stszData.uniform);
    const newSizes = [...existSizes, ...Array(nullCount).fill(nullSize)];

    const newSttsBuf = buildStts(newSttsEntries);
    const newStszBuf = buildStsz(newSizes);
    // stco will be built after we know the moov delta

    const sttsDelta = newSttsBuf.length - vstts.size;
    const stszDelta = newStszBuf.length - vstsz.size;
    const newStcoSize = 8 + 4 + 4 + (vstcoOffs.length + nullCount) * 4;
    const stcoDelta   = newStcoSize - vstco.size;

    // Silently remove udta box if present
    const udtaBox = findBox(buf, moovBox.dataOff, moovBox.end, 'udta');
    const udtaSize = udtaBox ? udtaBox.size : 0;
    const vidTrackDelta = sttsDelta + stszDelta + stcoDelta;
    const moovDelta   = vidTrackDelta - udtaSize;
    const newMoovSize = moovBox.size + moovDelta;

    onLog(
      `moov delta: +${moovDelta}B  (stts:${sttsDelta>=0?'+':''}${sttsDelta}  stsz:${stszDelta>=0?'+':''}${stszDelta}  stco:${stcoDelta>=0?'+':''}${stcoDelta})`,
      'info'
    );

    // ── 6. Compute null-frame stub location in new file ───────────────────
    const freeSize      = freeBox ? freeBox.size : 0;
    const newMdatStart  = ftypBox.size + newMoovSize + freeSize;
    const origPayload   = mdatBox.size - 8;
    const nullStubOffset = newMdatStart + 8 + origPayload; // right after original mdat payload

    // ── 7. Build new video stco (shifted existing + nullCount × stub) ─────
    const shiftedVidOffs = vstcoOffs.map(o => o + moovDelta);
    const newVidOffs     = [...shiftedVidOffs, ...Array(nullCount).fill(nullStubOffset)];
    const newStcoBuf     = buildStco(newVidOffs);

    // ── 8. Build new audio stco (same count, just shifted) ────────────────
    let aStcoBox=null, newAudioStcoBuf=null;
    if (audioTrak) {
      const aMdia = findBox(buf, audioTrak.dataOff, audioTrak.end, 'mdia');
      const aMinf = findBox(buf, aMdia.dataOff, aMdia.end, 'minf');
      const aStbl = findBox(buf, aMinf.dataOff, aMinf.end, 'stbl');
      aStcoBox = findBox(buf, aStbl.dataOff, aStbl.end, 'stco');
      if (aStcoBox) {
        const aOffs = parseStco(buf, aStcoBox);
        newAudioStcoBuf = buildStco(aOffs.map(o => o + moovDelta));
        // Verify same size (it must be — same entry count)
        if (newAudioStcoBuf.length !== aStcoBox.size)
          throw new Error('Audio stco size mismatch — unexpected structure');
        onLog(`Audio stco: ${aOffs.length} offsets shifted by +${moovDelta}`, 'info');
      }
    }

    // ── 9. Splice new moov ────────────────────────────────────────────────
    onLog('Splicing moov…', 'info');

    // Build replacement map: absolute file offset → new bytes
    const repMap = new Map();
    if (udtaBox) repMap.set(udtaBox.offset, new Uint8Array(0)); // remove udta box
    if (aStcoBox && newAudioStcoBuf) repMap.set(aStcoBox.offset, newAudioStcoBuf);
    repMap.set(vstts.offset, newSttsBuf);
    repMap.set(vstsz.offset, newStszBuf);
    repMap.set(vstco.offset, newStcoBuf);

    const reps = [...repMap.entries()].sort(([a],[b]) => a-b);

    const pieces = [];
    let src = moovBox.offset;
    for (const [repOff, repBuf] of reps) {
      if (repOff > src) pieces.push(buf.subarray(src, repOff));
      pieces.push(repBuf);
      src = repOff + r32(buf, repOff); // skip original box
    }
    if (src < moovBox.end) pieces.push(buf.subarray(src, moovBox.end));

    // Concatenate into single moov buffer
    const newMoovBuf = new Uint8Array(pieces.reduce((s,p) => s+p.length, 0));
    let wp=0; for (const p of pieces) { newMoovBuf.set(p, wp); wp+=p.length; }

    // Fix moov root size
    w32(newMoovBuf, 0, newMoovSize);

    const relOff = (absOff) => absOff - moovBox.offset;
    for (const box of [videoTrak, vMdia, vMinf, vStbl]) {
      w32(newMoovBuf, relOff(box.offset), box.size + vidTrackDelta);
    }

    onLog('Moov rebuilt ✓', 'ok');

    // ── 10. Assemble output file ──────────────────────────────────────────
    const newMdatSize = mdatBox.size + nullSize;
    const outSize = ftypBox.size + newMoovSize + freeSize + newMdatSize;
    const out = new Uint8Array(outSize);
    let op = 0;

    // ftyp (unchanged)
    out.set(buf.subarray(ftypBox.offset, ftypBox.end), op); op += ftypBox.size;

    // new moov
    out.set(newMoovBuf, op); op += newMoovBuf.length;

    // free (unchanged, if present)
    if (freeBox) { out.set(buf.subarray(freeBox.offset, freeBox.end), op); op += freeBox.size; }

    // new mdat header (larger size)
    w32(out, op, newMdatSize);
    out[op+4]=0x6D; out[op+5]=0x64; out[op+6]=0x61; out[op+7]=0x74; // 'mdat'
    op += 8;

    // original mdat payload (unchanged)
    out.set(buf.subarray(mdatBox.dataOff, mdatBox.end), op); op += origPayload;

    // null stub bytes (zero-filled by default, already 0 in new Uint8Array)
    op += nullSize;

    onLog(`Output: ${outSize} bytes  (in: ${len}, delta: +${outSize-len})`, 'ok');
    return out.buffer;
  }

  // ── Info probe (read-only, no patching) ──────────────────────────────────

  /**
   * Quickly probe an MP4 to extract video track info needed for Mode 3 UI.
   * Returns { timescale, sampleCount, stcoCount, isMovFirst, sttsEntries }
   */
  function probeVideo(arrayBuffer) {
    const buf = new Uint8Array(arrayBuffer);
    const len = buf.length;

    const ftypBox = findBox(buf, 0, len, 'ftyp');
    if (!ftypBox) return null;

    const moovBox = findBox(buf, ftypBox.end, len, 'moov');
    const mdatBox = findBox(buf, ftypBox.end, len, 'mdat');
    if (!moovBox || !mdatBox) return null;

    const isMovFirst = moovBox.offset < mdatBox.offset;
    const traks = findAll(buf, moovBox.dataOff, moovBox.end, 'trak');

    for (const trak of traks) {
      const mdia = findBox(buf, trak.dataOff, trak.end, 'mdia');
      if (!mdia) continue;
      const hdlr = findBox(buf, mdia.dataOff, mdia.end, 'hdlr');
      if (!hdlr) continue;
      if (r4cc(buf, hdlr.dataOff+8) !== 'vide') continue;

      const minf = findBox(buf, mdia.dataOff, mdia.end, 'minf');
      const stbl = findBox(buf, minf.dataOff, minf.end, 'stbl');
      const stts = findBox(buf, stbl.dataOff, stbl.end, 'stts');
      const stsz = findBox(buf, stbl.dataOff, stbl.end, 'stsz');
      const stco = findBox(buf, stbl.dataOff, stbl.end, 'stco');

      const ts = readTimescale(buf, mdia);
      const entries = stts ? parseStts(buf, stts) : [];
      const szData  = stsz ? parseStsz(buf, stsz) : { total: 0 };
      const coCount = stco ? r32(buf, stco.dataOff+4) : 0;

      return {
        timescale:   ts,
        sampleCount: szData.total,
        stcoCount:   coCount,
        sttsEntries: entries,
        isMovFirst,
        moovSize:    moovBox.size,
        mdatSize:    mdatBox.size,
      };
    }
    return null;
  }

  return { patch, probeVideo };
})();
