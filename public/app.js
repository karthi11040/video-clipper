/* video-clipper — front end
 * Resumable chunked upload (jobId + next chunk index persisted in localStorage),
 * client-side duration probe to preview clip counts, SSE for per-clip progress. */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  config: null,
  file: null,
  durationSec: null,
  jobId: null,
  nextChunk: 0,
  chunkSize: 4 * 1024 * 1024,
  uploadedBytes: 0,
  stopped: false,
};

// ---------- helpers ----------
const fmtBytes = (n) => (n / 1048576).toFixed(0) + ' MB';
const fmtTime = (s) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
};
function fingerprint() {
  return state.file ? `clipper:${state.file.name}:${state.file.size}:${state.file.lastModified}` : null;
}
function saveUploadState() {
  const fp = fingerprint();
  if (fp) localStorage.setItem(fp, JSON.stringify({ jobId: state.jobId, nextChunk: state.nextChunk }));
}
function loadUploadState() {
  const fp = fingerprint();
  if (!fp) return null;
  try { return JSON.parse(localStorage.getItem(fp)); } catch { return null; }
}
function clearUploadState() { const fp = fingerprint(); if (fp) localStorage.removeItem(fp); }

function logLine(html) {
  const li = document.createElement('li');
  li.innerHTML = html;
  $('log').appendChild(li);
  $('log').scrollTop = $('log').scrollHeight;
}

// ---------- boot ----------
(async function boot() {
  const res = await fetch('/api/config');
  state.config = await res.json();
  state.chunkSize = state.config.chunkSize;
  $('limitsHint').textContent =
    `Max ${state.config.maxUploadMB} MB · max ${Math.round(state.config.maxDurationSec / 60)} min · ` +
    `${state.config.supportedExtensions.map((e) => '.' + e).join(' ')}`;
  const list = $('formatList');
  for (const f of state.config.formats) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${f.key}" ${f.key === 'reel' ? 'checked' : ''}/> ${f.label}`;
    list.appendChild(label);
  }
  list.addEventListener('change', () => $('startBtn').disabled = !readyToStart());
})();

function readyToStart() {
  return state.file && state.durationSec &&
         document.querySelectorAll('#formatList input:checked').length > 0 &&
         !state.jobId;
}

// ---------- file selection ----------
$('browseBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => pickFile(e.target.files[0]);
const dz = $('dropzone');
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); };
dz.ondragleave = () => dz.classList.remove('drag');
dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('drag'); pickFile(e.dataTransfer.files[0]); };

async function pickFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!state.config.supportedExtensions.includes(ext)) {
    return fail(`Unsupported format ".${ext}". Use ${state.config.supportedExtensions.join(', ')}.`);
  }
  if (file.size > state.config.maxUploadMB * 1048576) {
    return fail(`File is ${fmtBytes(file.size)} — the limit is ${state.config.maxUploadMB} MB for browser processing. ` +
                `Try a smaller file, or run the app server-side with MAX_UPLOAD_MB raised.`);
  }
  state.file = file;
  state.durationSec = await probeDuration(file);
  $('fileName').textContent = `${file.name} · ${fmtBytes(file.size)} · ${fmtTime(state.durationSec)}`;
  $('uploadUI').hidden = false;
  ['step-length', 'step-formats'].forEach((id) => $(id).hidden = false);
  updateEstimate();
  // If a previous attempt died mid-upload, offer to resume where it left off.
  const saved = loadUploadState();
  if (saved && saved.jobId) {
    state.jobId = saved.jobId;
    state.nextChunk = saved.nextChunk;
    state.uploadedBytes = Math.min(state.nextChunk * state.chunkSize, file.size);
    updateUploadBar();
    $('uploadMsg').className = 'msg';
    $('uploadMsg').textContent = `Upload interrupted — ${state.nextChunk} chunks already sent.`;
    $('resumeBtn').hidden = false;
    $('startBtn').disabled = true;
  } else {
    startUpload();
  }
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { const d = v.duration; URL.revokeObjectURL(url); resolve(d); };
    v.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    v.src = url;
  });
}

function updateEstimate() {
  if (!state.durationSec) { $('estimate').textContent = 'Could not read duration — try another file.'; return; }
  const maxLen = Number($('clipLen').value || 1) * 60;
  const parts = Math.max(1, Math.ceil(state.durationSec / maxLen));
  $('estimate').textContent =
    `${fmtTime(state.durationSec)} ÷ ${fmtTime(maxLen)} → ${parts} clip${parts > 1 ? 's' : ''}` +
    ` (last clip runs ${fmtTime(state.durationSec - (parts - 1) * maxLen)}).`;
  $('startBtn').disabled = !readyToStart() || state.durationSec <= 0;
}
$('clipLen').oninput = updateEstimate;

// ---------- resumable chunked upload ----------
function updateUploadBar() {
  const pct = state.file ? Math.min(100, (state.uploadedBytes / state.file.size) * 100) : 0;
  $('uploadBar').value = pct;
  $('uploadPct').textContent = pct.toFixed(0) + '%';
}

async function startUpload() {
  state.stopped = false;
  $('resumeBtn').hidden = true;
  if (!state.jobId) {
    try {
      const res = await fetch('/api/upload/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: state.file.name, size: state.file.size, durationSec: state.durationSec }),
      });
      const data = await res.json();
      if (!res.ok) return fail(data.error);
      state.jobId = data.jobId;
      state.nextChunk = 0;
      state.uploadedBytes = 0;
      saveUploadState();
    } catch { return fail('Could not reach the server. Check your connection and retry.'); }
  }
  uploadChunks();
}

$('resumeBtn').onclick = startUpload;

async function uploadChunks() {
  const totalChunks = Math.ceil(state.file.size / state.chunkSize);
  $('uploadMsg').className = 'msg';
  $('uploadMsg').textContent = '';
  while (state.nextChunk < totalChunks && !state.stopped) {
    const blob = state.file.slice(state.nextChunk * state.chunkSize, (state.nextChunk + 1) * state.chunkSize);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const res = await fetch(`/api/upload/${state.jobId}/chunk?index=${state.nextChunk}`,
          { method: 'POST', body: (() => { const fd = new FormData(); fd.append('chunk', blob); return fd; })() });
        if (!res.ok) throw new Error(await res.text());
        ok = true;
      } catch (err) {
        if (attempt === 2) {
          $('uploadMsg').className = 'msg error';
          $('uploadMsg').textContent = `Chunk ${state.nextChunk} failed to upload. Fix your connection and press Resume — already-sent chunks are kept.`;
          $('resumeBtn').hidden = false;
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    state.nextChunk++;
    state.uploadedBytes += blob.size;
    updateUploadBar();
    saveUploadState();
  }
  if (state.stopped || state.nextChunk < totalChunks) return;

  try {
    const res = await fetch(`/api/upload/${state.jobId}/complete`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      clearUploadState();
      state.jobId = null;
      return fail(data.error);
    }
    clearUploadState();
    $('uploadMsg').className = 'msg ok';
    $('uploadMsg').textContent = 'Upload complete ✔';
    $('startBtn').disabled = false;
  } catch { fail('Server unreachable while finalizing. Press Resume to retry.'); $('resumeBtn').hidden = false; }
}

// ---------- processing ----------
$('startBtn').onclick = async () => {
  const maxLenSec = Number($('clipLen').value) * 60;
  const formats = [...document.querySelectorAll('#formatList input:checked')].map((c) => c.value);
  $('startBtn').disabled = true;
  $('step-progress').hidden = false;
  try {
    const res = await fetch(`/api/jobs/${state.jobId}/process`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxLenSec, formats }),
    });
    const data = await res.json();
    if (!res.ok) { $('startBtn').disabled = false; return fail(data.error); }
    listenForEvents();
  } catch { $('startBtn').disabled = false; fail('Could not start processing.'); }
};

function listenForEvents() {
  const es = new EventSource(`/api/jobs/${state.jobId}/events`);
  let done = 0, totalUnits = 1;
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'job-start') {
      totalUnits = m.totalParts * m.formats.length;
      logLine(`Started: ${m.totalParts} part(s) × ${m.formats.length} format(s).`);
    } else if (m.type === 'part-start') {
      logLine(`${m.format}/part${m.part} …`);
    } else if (m.type === 'part-done') {
      done++;
      logLine(`<span class="ok">✔</span> ${m.format}/part${m.part}`);
    } else if (m.type === 'part-failed') {
      done++;
      logLine(`<span class="err">✘ part${m.part} (${m.format}) failed: ${m.error}</span>`);
    } else if (m.type === 'job-done') {
      es.close();
      const pct = Math.round((done / totalUnits) * 100);
      $('overallBar').value = pct; $('overallPct').textContent = pct + '%';
      $('step-download').hidden = false;
      $('downloadBtn').href = m.downloadUrl;
      $('failedNote').textContent = m.failed.length
        ? `${m.failed.length} clip(s) failed (${m.failed.map((f) => f.format + '/part' + f.part).join(', ')}). The rest are in the ZIP.`
        : 'All clips processed successfully. The ZIP is grouped into folders per format.';
      $('step-download').scrollIntoView({ behavior: 'smooth' });
    }
    if (m.type === 'part-done' || m.type === 'part-failed') {
      const pct = Math.round((done / totalUnits) * 100);
      $('overallBar').value = pct; $('overallPct').textContent = pct + '%';
    }
  };
  es.onerror = () => { /* SSE auto-reconnects; download button appears on job-done */ };
}

function fail(msg) {
  $('uploadMsg').className = 'msg error';
  $('uploadMsg').textContent = msg;
  return msg;
}
