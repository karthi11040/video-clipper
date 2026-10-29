/**
 * video-clipper — back end
 * Node + Express + FFmpeg (ffmpeg-static, no system install needed).
 *
 * Flow:
 *   1. POST /api/upload/init        -> validate size/format, create a job dir, get a jobId
 *   2. POST /api/upload/:id/chunk   -> resumable chunked upload (client can resume after failure)
 *   3. POST /api/upload/:id/complete-> concatenate chunks, ffprobe the file (authoritative duration)
 *   4. POST /api/jobs/:id/process   -> split into <= maxLen segments, transcode each into each chosen ratio
 *   5. GET  /api/jobs/:id/events    -> SSE stream with per-clip progress
 *   6. GET  /api/jobs/:id/download  -> single ZIP (reel/part1.mp4, video/part1.mp4, ...), then cleanup
 */
'use strict';

const express      = require('express');
const multer       = require('multer');
const archiver     = require('archiver');
const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const ffmpeg       = require('fluent-ffmpeg');
const ffmpegPath   = require('ffmpeg-static');
const ffprobePath  = require('ffprobe-static').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// ----------------------------- configuration ------------------------------
const PORT            = Number(process.env.PORT || 3000);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 1024) * 1024 * 1024; // 1 GB default
const MAX_DURATION_SEC = Number(process.env.MAX_DURATION_SEC || 4 * 3600); // 4 h default
const CHUNK_SIZE = 4 * 1024 * 1024;   // client chunk size (server enforces max below)
const JOBS_DIR = path.join(__dirname, 'jobs');
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

const SUPPORTED_EXT = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpg', 'mpeg']);

// Aspect-ratio targets. Footage is scaled to FIT inside the frame and
// letter/pillar-boxed with black bars, so nothing is ever cropped and no
// frames are dropped. `key` becomes the subfolder name inside the ZIP.
const FORMATS = {
  reel:       { label: 'Reel / vertical (9:16)', w: 1080, h: 1920 },
  video:      { label: 'Video / landscape (16:9)', w: 1920, h: 1080 },
  square:     { label: 'Square (1:1)',           w: 1080, h: 1080 },
  portrait45: { label: 'Portrait (4:5)',         w: 1080, h: 1350 },
  legacy43:   { label: 'Classic (4:3)',          w: 1440, h: 1080 },
};

fs.mkdirSync(JOBS_DIR, { recursive: true });

// ------------------------------- job store --------------------------------
const jobs = new Map(); // id -> job

function newJob(originalName) {
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id, dir,
    originalName,
    filePath: path.join(dir, 'source' + path.extname(originalName).toLowerCase()),
    durationSec: null,
    status: 'uploading',          // uploading -> ready -> processing -> done
    formats: [],
    segments: [],
    failed: [],                   // [{format, part}]
    clients: new Set(),           // SSE response objects
  };
  jobs.set(id, job);
  return job;
}

function emit(job, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of job.clients) { try { res.write(data); } catch { job.clients.delete(res); } }
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      const d = Number(meta.format && meta.format.duration);
      if (!isFinite(d) || d <= 0) return reject(new Error('Could not read video duration.'));
      resolve(d);
    });
  });
}

// ------------------------------ processing --------------------------------
function buildSegments(duration, maxLen) {
  const segs = [];
  for (let start = 0; start < duration && segs.length < 5000; start += maxLen) {
    segs.push({ start, end: Math.min(start + maxLen, duration) });
  }
  return segs;
}

function transcodeSegment(job, key, fmt, seg, index, total) {
  const outDir = path.join(job.dir, 'out', key);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `part${index}.mp4`);
  return new Promise((resolve, reject) => {
    ffmpeg(job.filePath)
      .seekInput(seg.start)                       // input seek = frame-accurate cut point
      .inputFormat(path.extname(job.filePath).slice(1) === 'mkv' ? 'matroska' : undefined)
      .videoFilters(
        `scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${fmt.w}:${fmt.h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
      )
      .videoCodec('libx264')
      .addOptions(['-preset veryfast', '-crf 22', '-movflags +faststart'])
      .audioCodec('aac')                          // original audio kept, re-muxed to mp4-safe AAC
      .audioBitrate('160k')
      .duration(Math.max(0.1, seg.end - seg.start))
      .output(out)
      .on('progress', (p) => {
        emit(job, {
          type: 'progress', format: key, part: index, total,
          percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))),
        });
      })
      .on('end', () => resolve(out))
      .on('error', (err) => reject(err))
      .run();
  });
}

async function processJob(job, maxLen, formatKeys) {
  job.status = 'processing';
  job.formats = formatKeys;
  job.segments = buildSegments(job.durationSec, maxLen);
  const total = job.segments.length;
  emit(job, { type: 'job-start', totalParts: total, formats: formatKeys });

  for (const key of formatKeys) {
    const fmt = FORMATS[key];
    for (let i = 0; i < job.segments.length; i++) {
      const part = i + 1;
      emit(job, { type: 'part-start', format: key, part, total });
      try {
        await transcodeSegment(job, key, fmt, job.segments[i], part, total);
        emit(job, { type: 'part-done', format: key, part, total });
      } catch (err) {
        // One failed clip never kills the job — report it and keep going.
        job.failed.push({ format: key, part, error: String(err.message || err).slice(0, 300) });
        emit(job, { type: 'part-failed', format: key, part, total, error: job.failed[job.failed.length - 1].error });
      }
    }
  }

  job.status = 'done';
  emit(job, {
    type: 'job-done',
    failed: job.failed,
    downloadUrl: `/api/jobs/${job.id}/download`,
  });
}

// --------------------------------- app ------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CHUNK_BYTES } });

// expose limits so the UI can validate before uploading
app.get('/api/config', (req, res) => {
  res.json({
    maxUploadMB: MAX_UPLOAD / (1024 * 1024),
    maxDurationSec: MAX_DURATION_SEC,
    chunkSize: CHUNK_SIZE,
    formats: Object.entries(FORMATS).map(([key, f]) => ({ key, label: f.label, ratio: `${f.w}:${f.h}` })),
    supportedExtensions: [...SUPPORTED_EXT],
  });
});

// 1) init upload
app.post('/api/upload/init', (req, res) => {
  const { name, size } = req.body || {};
  const ext = path.extname(name || '').slice(1).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) {
    return res.status(415).json({
      error: `Unsupported format ".${ext}". Supported: ${[...SUPPORTED_EXT].join(', ')}`,
    });
  }
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'Invalid file size.' });
  if (size > MAX_UPLOAD) {
    return res.status(413).json({
      error: `File is ${(size / 1048576).toFixed(0)} MB — the browser-processing limit is ${MAX_UPLOAD / 1048576} MB. ` +
             `Use a smaller file, or run this app server-side with a raised MAX_UPLOAD_MB for larger sources.`,
    });
  }
  const job = newJob(name);
  res.json({ jobId: job.id, chunkSize: CHUNK_SIZE });
});

// 2) upload a chunk (index-based, resumable)
app.post('/api/upload/:jobId/chunk', upload.single('chunk'), (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  const index = Number(req.query.index);
  if (!Number.isInteger(index) || index < 0 || !req.file) return res.status(400).json({ error: 'Bad chunk.' });
  const chunkPath = path.join(job.dir, `chunk-${String(index).padStart(6, '0')}`);
  fs.writeFileSync(chunkPath, req.file.buffer);
  res.json({ ok: true, received: index });
});

// 3) complete: concatenate chunks in order, validate duration with ffprobe
app.post('/api/upload/:jobId/complete', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  try {
    const chunks = fs.readdirSync(job.dir).filter((f) => f.startsWith('chunk-')).sort();
    if (!chunks.length) return res.status(400).json({ error: 'No chunks received.' });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(job.filePath);
      const writeNext = (i) => {
        if (i >= chunks.length) return out.end();
        const r = fs.createReadStream(path.join(job.dir, chunks[i]));
        r.pipe(out, { end: false });
        r.on('end', () => writeNext(i + 1));
        r.on('error', reject);
      };
      out.on('finish', resolve);
      out.on('error', reject);
      writeNext(0);
    });
    chunks.forEach((c) => fs.rmSync(path.join(job.dir, c), { force: true }));

    job.durationSec = await probeDuration(job.filePath);
    if (job.durationSec > MAX_DURATION_SEC) {
      fs.rmSync(job.dir, { recursive: true, force: true });
      jobs.delete(job.id);
      return res.status(413).json({
        error: `Video is ${Math.round(job.durationSec / 60)} min — over the ${Math.round(MAX_DURATION_SEC / 60)} min browser-processing limit. ` +
               `Split the source first, or process server-side with a higher MAX_DURATION_SEC.`,
      });
    }
    job.status = 'ready';
    res.json({ ok: true, durationSec: Math.round(job.durationSec) });
  } catch (err) {
    res.status(422).json({ error: 'Could not read the uploaded file as video: ' + String(err.message || err) });
  }
});

// 4) start processing
app.post('/api/jobs/:jobId/process', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  if (job.status !== 'ready') return res.status(409).json({ error: `Job is "${job.status}".` });

  const maxLen = Number((req.body || {}).maxLenSec);
  const formatKeys = ((req.body || {}).formats || []).filter((k) => FORMATS[k]);
  if (!Number.isFinite(maxLen) || maxLen < 1 || maxLen > 1800)
    return res.status(400).json({ error: 'Clip length must be 1–1800 seconds (30 min).' });
  if (!formatKeys.length) return res.status(400).json({ error: 'Pick at least one format.' });

  processJob(job, maxLen, [...new Set(formatKeys)]).catch(() => {});
  res.json({ ok: true, parts: buildSegments(job.durationSec, maxLen).length });
});

// 5) SSE progress
app.get('/api/jobs/:jobId/events', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  job.clients.add(res);
  if (job.status === 'done') {
    res.write(`data: ${JSON.stringify({ type: 'job-done', failed: job.failed, downloadUrl: `/api/jobs/${job.id}/download` })}\n\n`);
  }
  req.on('close', () => job.clients.delete(res));
});

// 6) download ZIP + cleanup
app.get('/api/jobs/:jobId/download', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or already cleaned up.' });
  if (job.status !== 'done') return res.status(409).json({ error: 'Job is not finished.' });

  const zip = archiver('zip', { zlib: { level: 6 } });
  const outDir = path.join(job.dir, 'out');
  let count = 0;
  for (const key of job.formats) {
    const dir = path.join(outDir, key);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      zip.file(path.join(dir, f), { name: `${key}/${f}` }); // e.g. reel/part1.mp4
      count++;
    }
  }
  if (!count) {
    zip.destroy();
    return res.status(422).json({ error: 'No clips were produced (every part failed).' });
  }
  res.attachment(`clips-${job.id}.zip`);
  zip.pipe(res);
  zip.finalize();

  const cleanup = () => {
    for (const client of job.clients) { try { client.end(); } catch {} }
    jobs.delete(job.id);
    setTimeout(() => fs.rm(job.dir, { recursive: true, force: true }, () => {}), 500);
  };
  res.on('finish', cleanup);
  res.on('close', cleanup);
});

// sweeper: orphan jobs older than 2 h get cleaned up
setInterval(() => {
  const cutoff = Date.now() - 2 * 3600 * 1000;
  for (const [id, job] of jobs) {
    try {
      const stat = fs.statSync(job.dir);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(job.dir, { recursive: true, force: true });
        jobs.delete(id);
      }
    } catch { jobs.delete(id); }
  }
}, 15 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`video-clipper running → http://localhost:${PORT}`));
