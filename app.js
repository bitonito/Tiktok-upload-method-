/**
 * MP4 Box Patcher — Dual-Mode App Logic
 *
 * Mode 1 — Fragment (fMP4)
 *   Input:  standard MP4 (mp42, moov-at-end)
 *   Output: fragmented fMP4 (iso5, moov-at-start, moof+mdat chunks)
 *   FFmpeg: -c copy -movflags frag_keyframe+empty_moov+default_base_moof -f mp4
 *
 * Mode 2 — FastStart Re-encode
 *   Input:  any MP4 (isom, moov-at-end, large file)
 *   Output: H.264+AAC MP4 with moov-first (isom/avc1, faststart)
 *   FFmpeg: -c:v libx264 -crf <N> -c:a aac -movflags +faststart -f mp4
 *
 * Uses FFmpeg.wasm v0.11 (createFFmpeg UMD) — works from file:// without COOP/COEP.
 */

'use strict';

// ─── DOM ─────────────────────────────────────────────────────────────────────
const dropZone       = document.getElementById('dropZone');
const fileInput      = document.getElementById('fileInput');
const fileInfo       = document.getElementById('fileInfo');
const fileName       = document.getElementById('fileName');
const fileSize       = document.getElementById('fileSize');
const clearBtn       = document.getElementById('clearBtn');
const processBtn     = document.getElementById('processBtn');
const btnIcon        = document.getElementById('btnIcon');
const btnText        = document.getElementById('btnText');
const progressPanel  = document.getElementById('progressPanel');
const progressBar    = document.getElementById('progressBar');
const progressGlow   = document.getElementById('progressGlow');
const progressPct    = document.getElementById('progressPct');
const progressStatus = document.getElementById('progressStatus');
const logPanel       = document.getElementById('logPanel');
const resultPanel    = document.getElementById('resultPanel');
const resultStats    = document.getElementById('resultStats');
const resultTitle    = document.getElementById('resultTitle');
const resultIcon     = document.getElementById('resultIcon');
const downloadBtn    = document.getElementById('downloadBtn');
const downloadLabel  = document.getElementById('downloadLabel');
const resetBtn       = document.getElementById('resetBtn');
const statusDot      = document.getElementById('statusDot');
const statusText     = document.getElementById('statusText');
const dropSub        = document.getElementById('dropSub');
const crfSlider      = document.getElementById('crfSlider');
const crfValue       = document.getElementById('crfValue');
const stepLabel3     = document.getElementById('stepLabel3');

// Mode 3 params
const nullCountInput    = document.getElementById('nullCount');
const nullDurationInput = document.getElementById('nullDuration');
const nullSizeInput     = document.getElementById('nullSize');
const nullCountHint     = document.getElementById('nullCountHint');
const probeBar          = document.getElementById('probeBar');
const probeResult       = document.getElementById('probeResult');

const steps = { 1: document.getElementById('step1'), 2: document.getElementById('step2'), 3: document.getElementById('step3'), 4: document.getElementById('step4') };
// ─── State ────────────────────────────────────────────────────────────────────
let currentMode  = 1;       // 1 = Fragment, 2 = FastStart, 3 = Mode 3
let selectedFile = null;
let outputBlob   = null;
let ffmpegReady  = false;
let tickInterval = null;
let currentCRF   = 23;

// ─── Mode Tab Logic ───────────────────────────────────────────────────────────
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const mode = parseInt(tab.dataset.mode);
    if (mode === currentMode) return;
    SFX.click();
    setMode(mode);
  });
});

function setMode(mode) {
  currentMode = mode;

  // Tab active states
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', parseInt(t.dataset.mode) === mode));

  // Panel visibility
  document.getElementById('modePanel1').classList.toggle('hidden', mode !== 1);
  document.getElementById('modePanel2').classList.toggle('hidden', mode !== 2);
  document.getElementById('modePanel3').classList.toggle('hidden', mode !== 3);

  // Process button style & label
  processBtn.classList.remove('mode2', 'mode3');
  if (mode === 1) {
    btnIcon.textContent = '⚡';
    btnText.textContent = 'Fragmentize MP4';
    stepLabel3.textContent = 'Converting to fMP4';
  } else if (mode === 2) {
    processBtn.classList.add('mode2');
    btnIcon.textContent = '🎬';
    btnText.textContent = 'Re-encode + FastStart';
    stepLabel3.textContent = 'Re-encoding H.264+AAC';
  } else {
    processBtn.classList.add('mode3');
    btnIcon.textContent = '🧬';
    btnText.textContent = 'Patch Video Track';
    stepLabel3.textContent = 'Patching stts/stsz/stco';
    if (selectedFile) processBtn.disabled = false;
  }

  // If switching TO mode 3, probe the loaded file if any
  if (mode === 3 && selectedFile) probeVideoForMode3(selectedFile);
  if (mode !== 3) removeSizeWarning();

  // Reset state
  clearFile();
  resultPanel.style.display = 'none';
  progressPanel.style.display = 'none';
}

// ─── CRF Slider ───────────────────────────────────────────────────────────────
if (crfSlider) {
  crfSlider.addEventListener('input', () => {
    currentCRF = parseInt(crfSlider.value);
    crfValue.textContent = currentCRF;
    // Deactivate preset chips if custom value
    document.querySelectorAll('.qchip').forEach(c => {
      c.classList.toggle('active', parseInt(c.dataset.crf) === currentCRF);
    });
  });
}

document.querySelectorAll('.qchip').forEach(chip => {
  chip.addEventListener('click', () => {
    SFX.click();
    const crf = parseInt(chip.dataset.crf);
    currentCRF = crf;
    crfSlider.value = crf;
    crfValue.textContent = crf;
    document.querySelectorAll('.qchip').forEach(c => c.classList.toggle('active', c === chip));
  });
});

// ─── FFmpeg.wasm v0.11 Loading ────────────────────────────────────────────────
const FFMPEG_CDN_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js';

let ffmpegInstance = null;
let fetchFileFn    = null;

async function loadFFmpeg() {
  updateStatus('loading', 'Loading FFmpeg.wasm engine…');
  try {
    await loadScript(FFMPEG_CDN_URL);

    const { createFFmpeg, fetchFile } = window.FFmpeg;
    fetchFileFn = fetchFile;

    ffmpegInstance = createFFmpeg({
      log: false,
      progress: ({ ratio }) => {
        const pct = Math.min(Math.round(ratio * 100), 98);
        setProgress(20 + pct * 0.75);
      },
    });

    ffmpegInstance.setLogger(({ type, message }) => {
      if (type === 'fferr' || type === 'ffout') addLog(message);
    });

    addLog('Loading FFmpeg core WASM…', 'info');
    await ffmpegInstance.load();

    ffmpegReady = true;
    updateStatus('ready', 'FFmpeg.wasm ready ✓');
    addLog('FFmpeg.wasm v0.11 loaded ✓', 'ok');
    if (selectedFile) processBtn.disabled = false;
  } catch (err) {
    console.error('FFmpeg load error:', err);
    updateStatus('error', 'Failed to load FFmpeg.wasm — check internet');
    addLog('⚠ Error: ' + err.message, 'warn');
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load script: ' + src));
    document.head.appendChild(s);
  });
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function updateStatus(state, msg) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = msg;
}

function setProgress(pct) {
  const p = Math.min(100, Math.max(0, pct));
  progressBar.style.width = p + '%';
  progressGlow.style.width = p + '%';
  progressPct.textContent = Math.round(p) + '%';
}

function setStep(n, state) {
  if (steps[n]) steps[n].className = 'step ' + state;
}

function addLog(msg, cls = '') {
  const d = document.createElement('div');
  d.className = 'log-line ' + cls;
  d.textContent = msg;
  logPanel.appendChild(d);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ─── File Handling ────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file || !file.name.match(/\.mp4$/i)) {
    showError('Please select a valid .mp4 file.');
    SFX.error(); return;
  }
  removeError();
  removeSizeWarning();
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  fileInfo.style.display = 'flex';
  dropZone.style.display = 'none';

  // Mode 3 doesn't need FFmpeg
  if (currentMode === 3) {
    processBtn.disabled = false;
    probeVideoForMode3(file);
  } else {
    if (ffmpegReady) processBtn.disabled = false;
  }

  SFX.fileSelect();
  outputBlob = null;

  // Warn if Mode 2 re-encode on a large file
  if (currentMode === 2) {
    const MB = file.size / (1024 * 1024);
    if (MB > 400) {
      showSizeWarning(
        `⚠ Large file (${formatBytes(file.size)}) — re-encoding may run out of browser memory. ` +
        `Will auto-use fastest preset. If it still fails, use the "FastStart Copy" fallback (no re-encode).`
      );
    } else if (MB > 200) {
      showSizeWarning(
        `ℹ Large file (${formatBytes(file.size)}) — switching to faster encode preset to save memory.`
      );
    }
  }
}

function clearFile() {
  selectedFile = null;
  outputBlob = null;
  fileInput.value = '';
  fileInfo.style.display = 'none';
  dropZone.style.display = '';
  processBtn.disabled = true;
  removeError();
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────
let dragEnterCount = 0;
dropZone.addEventListener('dragenter', e => { e.preventDefault(); dragEnterCount++; dropZone.classList.add('drag-over'); SFX.dragHover(); });
dropZone.addEventListener('dragleave', () => { dragEnterCount--; if (dragEnterCount <= 0) { dragEnterCount = 0; dropZone.classList.remove('drag-over'); } });
dropZone.addEventListener('dragover', e => e.preventDefault());
dropZone.addEventListener('drop', e => { e.preventDefault(); dragEnterCount = 0; dropZone.classList.remove('drag-over'); handleFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
clearBtn.addEventListener('click', () => { clearFile(); SFX.click(); });

// ─── Error Banner ─────────────────────────────────────────────────────────────
function showError(msg) {
  removeError();
  const div = document.createElement('div');
  div.className = 'error-banner'; div.id = 'errorBanner';
  div.textContent = '⚠ ' + msg;
  document.querySelector('.upload-section').appendChild(div);
}
function removeError() { const e = document.getElementById('errorBanner'); if (e) e.remove(); }

// Size warning (yellow, non-blocking)
function showSizeWarning(msg) {
  removeSizeWarning();
  const div = document.createElement('div');
  div.className = 'size-warn-banner'; div.id = 'sizeWarnBanner';
  div.textContent = msg;
  document.querySelector('.upload-section').appendChild(div);
}
function removeSizeWarning() { const e = document.getElementById('sizeWarnBanner'); if (e) e.remove(); }

// ─── Mode 3: Probe video file (no FFmpeg) ────────────────────────────────────
async function probeVideoForMode3(file) {
  probeBar.style.display = 'flex';
  probeResult.textContent = 'Probing…';
  try {
    const buf = await file.arrayBuffer();
    const info = MP4Patcher.probeVideo(buf);
    if (!info) {
      probeResult.textContent = '⚠ Could not parse MP4 structure';
      return;
    }
    if (!info.isMovFirst) {
      probeResult.textContent = '⚠ moov is AFTER mdat — run Mode 2 FastStart Copy first!';
      showError('This file has moov-at-end layout. Run Mode 2 → FastStart Copy first, then apply Mode 3.');
      processBtn.disabled = true;
      return;
    }
    const sttsStr = info.sttsEntries.map(e => `(${e.count},${e.duration})`).join(', ');
    probeResult.textContent =
      `✓ moov-first · timescale: ${info.timescale} · stsz: ${info.sampleCount} · stco: ${info.stcoCount} · stts: [${sttsStr}]`;
    updateNullCountHint();
  } catch (e) {
    probeResult.textContent = 'Probe error: ' + e.message;
  }
}

let _probeTimescale = 0;
function updateNullCountHint() {
  const count = parseInt(nullCountInput.value) || 0;
  const dur   = parseInt(nullDurationInput.value) || 1500;
  // Try to get timescale from probe result text
  const m = probeResult.textContent.match(/timescale:\s*(\d+)/);
  const ts = m ? parseInt(m[1]) : 15360;
  const extSec = (count * dur / ts).toFixed(1);
  const extMin = (extSec / 60).toFixed(1);
  nullCountHint.textContent =
    `+${extSec}s (${extMin}min) media timeline at timescale ${ts}`;
}

// Wire Mode 3 param inputs
if (nullCountInput) {
  nullCountInput.addEventListener('input', updateNullCountHint);
  nullDurationInput.addEventListener('input', updateNullCountHint);
}

// Mode 3 preset chips
document.querySelectorAll('.m3chip').forEach(chip => {
  chip.addEventListener('click', () => {
    SFX.click();
    nullCountInput.value    = chip.dataset.count;
    nullDurationInput.value = chip.dataset.dur;
    document.querySelectorAll('.m3chip').forEach(c => c.classList.toggle('active', c === chip));
    updateNullCountHint();
  });
});

// ─── PROCESS ─────────────────────────────────────────────────────────────────
processBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  if (currentMode !== 3 && !ffmpegReady) return;
  SFX.processStart();
  await runConversion();
});
processBtn.addEventListener('mousedown', () => { if (!processBtn.disabled) SFX.click(); });

async function runConversion() {
  try {
    progressPanel.style.display = 'block';
    resultPanel.style.display = 'none';
    setProgress(0);
    logPanel.innerHTML = '';
    [1, 2, 3, 4].forEach(n => setStep(n, ''));
    processBtn.disabled = true;

    // Step 1: engine ready
    setStep(1, 'done');
    setProgress(5);

    // Step 2: read file
    setStep(2, 'active');
    progressStatus.textContent = 'Reading input file…';
    addLog(`Input: ${selectedFile.name} (${formatBytes(selectedFile.size)})`, 'info');

    const inputData = await fetchFileFn(selectedFile);
    ffmpegInstance.FS('writeFile', 'input.mp4', inputData);

    setStep(2, 'done');
    setProgress(20);

    // Step 3: convert
    setStep(3, 'active');

    if (currentMode === 3) {
      // Mode 3: pure JS — no FFmpeg tick interval
      await runMode3();
    } else {
      tickInterval = setInterval(() => SFX.tick(), 900);
      if (currentMode === 1) {
        await runMode1();
      } else {
        await runMode2();
      }
      clearInterval(tickInterval); tickInterval = null;
    }

    setStep(3, 'done');
    setProgress(95);
    addLog('Conversion complete ✓', 'ok');

    // Step 4: package
    setStep(4, 'active');
    progressStatus.textContent = 'Packaging output…';

    if (currentMode === 3) {
      // outputBlob already set by runMode3
      setStep(4, 'done');
      setProgress(100);
      progressStatus.textContent = 'Done!';
      progressStatus.style.animation = 'none';
      addLog(`Output: ${formatBytes(outputBlob.size)}`, 'ok');
      setTimeout(showResult, 400);
      SFX.success();
    } else {
      const data = await ffmpegInstance.FS('readFile', 'output.mp4');
      outputBlob = new Blob([data.buffer], { type: 'video/mp4' });
      try { ffmpegInstance.FS('unlink', 'input.mp4'); } catch(_){}
      try { ffmpegInstance.FS('unlink', 'output.mp4'); } catch(_){}
      setStep(4, 'done');
      setProgress(100);
      progressStatus.textContent = 'Done!';
      progressStatus.style.animation = 'none';
      addLog(`Output: ${formatBytes(outputBlob.size)}`, 'ok');
      setTimeout(showResult, 400);
      SFX.success();
    }

  } catch (err) {
    clearInterval(tickInterval); tickInterval = null;
    console.error('Conversion error:', err);
    progressStatus.textContent = 'Error occurred';
    progressStatus.style.animation = 'none';

    const isOOM = err.message && (
      err.message.includes('OOM') ||
      err.message.includes('out of memory') ||
      err.message.includes('RuntimeError') ||
      err.message.includes('abort')
    );

    if (isOOM && currentMode === 2) {
      // OOM during re-encode — offer copy fallback
      addLog('OUT OF MEMORY — file too large for browser re-encode.', 'warn');
      addLog('Offering FastStart Copy fallback (no re-encode)…', 'info');
      showOomFallback();
    } else {
      addLog('ERROR: ' + err.message, 'warn');
      showError('Conversion failed: ' + err.message);
    }
    processBtn.disabled = false;
    SFX.error();
  }
}

// ─── Mode 1: Fragment → fMP4 ──────────────────────────────────────────────────
async function runMode1() {
  progressStatus.textContent = 'Converting to fragmented fMP4…';
  addLog('ffmpeg -i input.mp4 -c copy -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 output.mp4', 'info');

  await ffmpegInstance.run(
    '-i', 'input.mp4',
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'output.mp4'
  );
}

// ─── Mode 2: FastStart H.264 Re-encode ───────────────────────────────────────
// Auto-selects preset based on file size to avoid WASM OOM:
//   < 200 MB  → medium  (best quality, reasonable speed)
//   200–400 MB → fast   (reduced memory lookahead)
//   > 400 MB  → ultrafast (minimal memory, still re-encodes)
async function runMode2() {
  const MB      = selectedFile.size / (1024 * 1024);
  const preset  = MB > 400 ? 'ultrafast' : MB > 200 ? 'fast' : 'medium';
  const threads = MB > 400 ? '2' : '4';  // fewer threads = less peak memory

  progressStatus.textContent = `Re-encoding H.264 CRF ${currentCRF} [${preset}]…`;
  addLog(`ffmpeg -i input.mp4 -c:v libx264 -crf ${currentCRF} -preset ${preset} -threads ${threads} -c:a aac -movflags +faststart -f mp4 output.mp4`, 'info');

  if (MB > 200) addLog(`ℹ Auto-preset: "${preset}" — file is ${formatBytes(selectedFile.size)}`, 'info');

  await ffmpegInstance.run(
    '-i', 'input.mp4',
    '-c:v', 'libx264',
    '-crf', String(currentCRF),
    '-preset', preset,
    '-threads', threads,
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-f', 'mp4',
    'output.mp4'
  );
}

// ─── Mode 2 Fallback: FastStart Copy (no re-encode, any file size) ────────────
async function runMode2Copy() {
  progressStatus.textContent = 'FastStart Copy — moving moov to front…';
  addLog('ffmpeg -i input.mp4 -c copy -movflags +faststart -f mp4 output.mp4', 'info');
  addLog('Streams copied — no re-encode (preserves original quality & size)', 'info');

  await ffmpegInstance.run(
    '-i', 'input.mp4',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4',
    'output.mp4'
  );
}

// ─── Mode 3: Null-Frame Video Extension (Pure JS) ────────────────────────────
async function runMode3() {
  progressStatus.textContent = 'Patching sample tables (Pure JS)…';
  addLog('Initializing Pure JS MP4 Box Patcher…', 'info');

  const count = parseInt(nullCountInput.value) || 8573;
  const dur   = parseInt(nullDurationInput.value) || 1500;
  const size  = parseInt(nullSizeInput.value) || 8;

  addLog(`Target: Append ${count} null frames`, 'info');
  addLog(`Duration per frame: ${dur} ticks`, 'info');
  addLog(`Payload stub size: ${size} bytes`, 'info');

  const arrayBuffer = await selectedFile.arrayBuffer();

  const logCallback = (msg, level) => {
    addLog(msg, level || 'info');
  };

  try {
    const patchedBuffer = MP4Patcher.patch(arrayBuffer, count, dur, size, logCallback);
    outputBlob = new Blob([patchedBuffer], { type: 'video/mp4' });
    addLog('Video track sample tables patched successfully!', 'ok');
  } catch (err) {
    addLog('Patching error: ' + err.message, 'warn');
    throw err;
  }
}

// ─── OOM Fallback UI ─────────────────────────────────────────────────────────
function showOomFallback() {
  progressStatus.textContent = 'Out of Memory — use FastStart Copy';

  const existing = document.getElementById('oomFallback');
  if (existing) existing.remove();

  const box = document.createElement('div');
  box.id = 'oomFallback';
  box.className = 'oom-fallback';
  box.innerHTML = `
    <div class="oom-icon">💾</div>
    <div class="oom-title">Browser Memory Limit Reached</div>
    <div class="oom-body">
      Re-encoding a <strong>${formatBytes(selectedFile.size)}</strong> file at this resolution
      exceeds the FFmpeg.wasm memory ceiling (~512 MB). Choose a fallback:
    </div>
    <div class="oom-actions">
      <button class="oom-btn primary" id="oomCopyBtn">⚡ FastStart Copy <span class="oom-btn-sub">move moov first · no re-encode · same quality</span></button>
      <button class="oom-btn secondary" id="oomMode1Btn">📦 Switch to Mode 1 <span class="oom-btn-sub">fragment to fMP4 · also lossless</span></button>
    </div>
  `;
  progressPanel.appendChild(box);

  document.getElementById('oomCopyBtn').addEventListener('click', async () => {
    box.remove();
    SFX.processStart();
    try {
      setStep(3, 'active');
      tickInterval = setInterval(() => SFX.tick(), 900);
      progressStatus.textContent = 'FastStart Copy in progress…';
      progressStatus.style.animation = '';

      await runMode2Copy();

      clearInterval(tickInterval); tickInterval = null;
      setStep(3, 'done');
      setProgress(95);

      setStep(4, 'active');
      progressStatus.textContent = 'Packaging output…';
      const data = await ffmpegInstance.FS('readFile', 'output.mp4');
      outputBlob = new Blob([data.buffer], { type: 'video/mp4' });
      try { ffmpegInstance.FS('unlink', 'input.mp4'); } catch(_){}
      try { ffmpegInstance.FS('unlink', 'output.mp4'); } catch(_){}

      setStep(4, 'done');
      setProgress(100);
      progressStatus.textContent = 'Done!';
      progressStatus.style.animation = 'none';
      addLog(`Output: ${formatBytes(outputBlob.size)}`, 'ok');
      addLog('Format: moov@start · streams copied · faststart ✓', 'ok');
      setTimeout(showResultCopy, 400);
      SFX.success();
    } catch (err2) {
      clearInterval(tickInterval); tickInterval = null;
      addLog('ERROR: ' + err2.message, 'warn');
      showError('Copy also failed: ' + err2.message + ' — file may be too large even for copy.');
      SFX.error();
    }
  });

  document.getElementById('oomMode1Btn').addEventListener('click', () => {
    box.remove();
    SFX.click();
    setMode(1);
    // re-write input to WASM FS and go
    setTimeout(async () => {
      if (selectedFile) {
        fileInfo.style.display = 'flex';
        dropZone.style.display = 'none';
        processBtn.disabled = false;
        progressPanel.style.display = 'none';
        [1,2,3,4].forEach(n => setStep(n,''));
        setProgress(0);
        logPanel.innerHTML = '';
        progressStatus.textContent = 'Initializing…';
        progressStatus.style.animation = '';
      }
    }, 100);
  });
}

function showResultCopy() {
  resultPanel.style.display = 'block';
  resultPanel.className = 'result-panel mode2';
  resultIcon.textContent = '✅';
  resultTitle.textContent = 'FastStart Copy Complete!';

  const inSize  = formatBytes(selectedFile.size);
  const outSize = formatBytes(outputBlob.size);
  const diff    = outputBlob.size - selectedFile.size;
  const pct     = ((Math.abs(diff) / selectedFile.size) * 100).toFixed(1);
  const diffStr = diff > 0 ? `+${formatBytes(diff)}` : `-${formatBytes(Math.abs(diff))}`;
  const outName = selectedFile.name.replace(/\.mp4$/i, '_faststart.mp4');

  resultStats.innerHTML = `
    <div><strong>Input:</strong> ${selectedFile.name} — ${inSize}</div>
    <div><strong>Output:</strong> ${outName} — ${outSize} (${diffStr}, ${pct}%)</div>
    <div><strong>Format:</strong> ftyp <code style="color:#2dd4bf">isom</code> · moov@start · original streams</div>
    <div><strong>Encoding:</strong> Streams copied (no re-encode) · faststart ✓</div>
  `;

  downloadBtn.className = 'download-btn mode2';
  downloadLabel.textContent = '⬇ Download FastStart MP4';
  downloadBtn.onclick = () => {
    SFX.download();
    const url = URL.createObjectURL(outputBlob);
    const a = document.createElement('a');
    a.href = url; a.download = outName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
}

// ─── Show Result ──────────────────────────────────────────────────────────────
function showResult() {
  const isMode2 = currentMode === 2;
  const isMode3 = currentMode === 3;

  resultPanel.style.display = 'block';
  if (isMode3) {
    resultPanel.className = 'result-panel mode3';
    resultIcon.textContent = '🧬';
    resultTitle.textContent = 'Null-Frame Patch Complete!';
  } else {
    resultPanel.className = 'result-panel' + (isMode2 ? ' mode2' : '');
    resultIcon.textContent = '✅';
    resultTitle.textContent = isMode2 ? 'FastStart Re-encode Complete!' : 'Fragmentation Complete!';
  }

  const inSize  = formatBytes(selectedFile.size);
  const outSize = formatBytes(outputBlob.size);
  const diff    = outputBlob.size - selectedFile.size;
  const pct     = ((Math.abs(diff) / selectedFile.size) * 100).toFixed(1);
  const diffStr = diff > 0 ? `+${formatBytes(diff)}` : `-${formatBytes(Math.abs(diff))}`;

  let suffix = '_fragmented.mp4';
  if (isMode2) suffix = '_faststart.mp4';
  if (isMode3) suffix = '_padded.mp4';
  const outName = selectedFile.name.replace(/\.mp4$/i, suffix);

  let formatLine = `ftyp <code style="color:#22d3ee">iso5/iso6/mp41</code> · moov@start · moof+mdat fragments`;
  if (isMode2) {
    formatLine = `ftyp <code style="color:#2dd4bf">isom/iso2/avc1/mp41</code> · moov@start · H.264+AAC`;
  } else if (isMode3) {
    formatLine = `ftyp <code style="color:#fcd34d">isom/iso2/avc1/mp41</code> · moov@start (padded stts/stsz/stco)`;
  }

  let streamsLine = `Streams copied — no re-encode`;
  if (isMode2) {
    streamsLine = `H.264 (CRF ${currentCRF}) · AAC audio · faststart`;
  } else if (isMode3) {
    const count = parseInt(nullCountInput.value) || 8573;
    const dur   = parseInt(nullDurationInput.value) || 1500;
    streamsLine = `Appended ${count} null frames (${dur} ticks each) · No re-encode`;
  }

  resultStats.innerHTML = `
    <div><strong>Input:</strong> ${selectedFile.name} — ${inSize}</div>
    <div><strong>Output:</strong> ${outName} — ${outSize} (${diffStr}, ${pct}%)</div>
    <div><strong>Format:</strong> ${formatLine}</div>
    <div><strong>Encoding:</strong> ${streamsLine}</div>
  `;

  if (isMode3) {
    downloadBtn.className = 'download-btn mode3';
    downloadLabel.textContent = '⬇ Download Patched MP4';
  } else {
    downloadBtn.className = 'download-btn' + (isMode2 ? ' mode2' : '');
    downloadLabel.textContent = `⬇ Download ${isMode2 ? 'FastStart MP4' : 'fMP4'}`;
  }

  downloadBtn.onclick = () => {
    SFX.download();
    const url = URL.createObjectURL(outputBlob);
    const a = document.createElement('a');
    a.href = url; a.download = outName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
}

// ─── Reset ────────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  SFX.click();
  clearFile();
  progressPanel.style.display = 'none';
  resultPanel.style.display = 'none';
  [1, 2, 3, 4].forEach(n => setStep(n, ''));
  setProgress(0);
  logPanel.innerHTML = '';
  progressStatus.textContent = 'Initializing…';
  progressStatus.style.animation = '';
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadFFmpeg();
