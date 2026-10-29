(() => {
  const $ = (selector) => document.querySelector(selector);
  const videoInput = $('#videoInput');
  const dropzone = $('#dropzone');
  const dropTitle = $('#dropTitle');
  const dropSubtitle = $('#dropSubtitle');
  const fileInfo = $('#fileInfo');
  const resumeNotice = $('#resumeNotice');
  const uploadButton = $('#uploadButton');
  const uploadButtonText = $('#uploadButtonText');
  const uploadProgressWrap = $('#uploadProgressWrap');
  const uploadProgressLabel = $('#uploadProgressLabel');
  const uploadPercent = $('#uploadPercent');
  const uploadProgressBar = $('#uploadProgressBar');
  const uploadProgressDetail = $('#uploadProgressDetail');
  const uploadStatus = $('#uploadStatus');
  const clipMinutesInput = $('#clipMinutes');
  const clipCount = $('#clipCount');
  const clipCountDetail = $('#clipCountDetail');
  const formatGrid = $('#formatGrid');
  const startButton = $('#startButton');
  const startButtonText = $('#startButtonText');
  const startStatus = $('#startStatus');
  const jobCard = $('#jobCard');
  const jobTitle = $('#jobTitle');
  const jobSubtitle = $('#jobSubtitle');
  const jobStatusPill = $('#jobStatusPill');
  const overallLabel = $('#overallLabel');
  const overallPercent = $('#overallPercent');
  const overallProgressBar = $('#overallProgressBar');
  const jobOutputCounts = $('#jobOutputCounts');
  const jobClipCountLabel = $('#jobClipCountLabel');
  const outputList = $('#outputList');
  const jobFailures = $('#jobFailures');
  const downloadPanel = $('#downloadPanel');
  const downloadButton = $('#downloadButton');
  const downloadDescription = $('#downloadDescription');

  const STORAGE_KEY = 'clipforge.upload.v1';
  const CHUNK_FALLBACK = 8 * 1024 * 1024;
  const fallbackMaxBytes = 3 * 1024 * 1024 * 1024;
  const allowedExtensions = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpeg', 'mpg', '3gp', 'wmv', 'ts']);

  let maxUploadBytes = fallbackMaxBytes;
  let chunkBytes = CHUNK_FALLBACK;
  let serverReady = false;
  let selectedFile = null;
  let currentUploadId = null;
  let uploadedVideo = null;
  let resumeSession = null;
  let uploadBusy = false;
  let processBusy = false;
  let currentJobId = null;
  let pollingTimer = null;

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const total = Math.floor(seconds + 0.0001);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
    if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
    return `${secs}s`;
  }

  function setStatus(element, message = '', kind = '') {
    element.textContent = message;
    element.className = `inline-status${kind ? ` ${kind}` : ''}`;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, options);
    let data = {};
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try { data = await response.json(); } catch (_) { data = {}; }
    }
    if (!response.ok) {
      throw new Error(data.detail || data.message || `Request failed (${response.status}).`);
    }
    return data;
  }

  function saveSession(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    resumeSession = data;
  }

  function clearSavedSession() {
    localStorage.removeItem(STORAGE_KEY);
    resumeSession = null;
  }

  function updateUploadButton() {
    if (uploadBusy) {
      uploadButton.disabled = true;
      uploadButtonText.textContent = 'Uploading…';
      return;
    }
    if (processBusy && currentJobId) {
      uploadButton.disabled = true;
      uploadButtonText.textContent = 'Job is processing';
      return;
    }
    if (uploadedVideo && currentUploadId) {
      uploadButton.disabled = true;
      uploadButtonText.textContent = 'Upload complete';
      return;
    }
    if (!selectedFile) {
      uploadButton.disabled = true;
      uploadButtonText.textContent = 'Choose a video first';
      return;
    }
    uploadButton.disabled = false;
    const canResume = currentUploadId && resumeSession && selectedFile.name === resumeSession.filename && selectedFile.size === resumeSession.size;
    uploadButtonText.textContent = canResume ? 'Resume upload' : 'Upload video';
  }

  function getSelectedFormats() {
    return [...formatGrid.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  }

  function updateFormatCards() {
    formatGrid.querySelectorAll('.format-card').forEach((card) => {
      const input = card.querySelector('input');
      card.classList.toggle('selected', input.checked);
    });
    updateStartButton();
  }

  function updateClipPreview() {
    const minutes = Number(clipMinutesInput.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
      clipCount.textContent = '—';
      clipCountDetail.textContent = 'Enter a whole number from 1 to 30 minutes.';
      updateStartButton();
      return;
    }
    if (!uploadedVideo || !Number.isFinite(uploadedVideo.duration_seconds)) {
      clipCount.textContent = '—';
      clipCountDetail.textContent = 'Upload a video to calculate the number of segments.';
      updateStartButton();
      return;
    }
    const duration = Number(uploadedVideo.duration_seconds);
    const length = minutes * 60;
    const count = Math.max(1, Math.ceil(duration / length));
    const remainder = duration - Math.floor(duration / length) * length;
    clipCount.textContent = String(count);
    if (count === 1) {
      clipCountDetail.textContent = `One segment · ${formatDuration(duration)} total.`;
    } else if (remainder > 0.75 && remainder < length - 0.75) {
      clipCountDetail.textContent = `${count - 1} segment${count - 1 === 1 ? '' : 's'} of up to ${minutes} min, plus a final ${formatDuration(remainder)} remainder.`;
    } else {
      clipCountDetail.textContent = `${count} consecutive segments · none longer than ${minutes} min.`;
    }
    updateStartButton();
  }

  function updateStartButton() {
    const minutes = Number(clipMinutesInput.value);
    const formats = getSelectedFormats();
    const ready = Boolean(serverReady && uploadedVideo && currentUploadId && Number.isInteger(minutes) && minutes >= 1 && minutes <= 30 && formats.length && !processBusy && !uploadBusy);
    startButton.disabled = !ready;
    if (processBusy) startButtonText.textContent = 'Processing…';
    else if (!serverReady) startButtonText.textContent = 'FFmpeg unavailable';
    else if (!uploadedVideo) startButtonText.textContent = 'Upload your video first';
    else if (!formats.length) startButtonText.textContent = 'Select an output format';
    else startButtonText.textContent = 'Start processing';
  }

  function renderSelectedFile(file) {
    dropTitle.textContent = file.name;
    dropSubtitle.textContent = `${formatBytes(file.size)} · Ready to upload`;
    fileInfo.hidden = false;
    fileInfo.textContent = `${file.name}  ·  ${formatBytes(file.size)}`;
  }

  function selectFile(file) {
    if (!file) return;
    if (processBusy && currentJobId) {
      setStatus(uploadStatus, 'Please let the current job finish before uploading another video.', 'error');
      return;
    }
    const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    if (!allowedExtensions.has(extension)) {
      selectedFile = null;
      uploadedVideo = null;
      currentUploadId = null;
      resumeNotice.hidden = true;
      setStatus(uploadStatus, 'That file type is not supported. Choose a video file such as MP4, MOV, MKV or WEBM.', 'error');
      updateUploadButton();
      updateClipPreview();
      return;
    }
    if (file.size > maxUploadBytes) {
      selectedFile = null;
      uploadedVideo = null;
      currentUploadId = null;
      setStatus(uploadStatus, `This server accepts files up to ${formatBytes(maxUploadBytes)}. Choose a smaller file, or increase MAX_UPLOAD_BYTES on a server with sufficient disk space.`, 'error');
      updateUploadButton();
      updateClipPreview();
      return;
    }

    const modifiedMatches = !resumeSession?.lastModified || !file.lastModified || Number(resumeSession.lastModified) === Number(file.lastModified);
    const sameResumable = resumeSession && modifiedMatches && file.name === resumeSession.filename && file.size === resumeSession.size;
    selectedFile = file;
    renderSelectedFile(file);
    setStatus(uploadStatus, '');

    if (sameResumable) {
      currentUploadId = resumeSession.uploadId;
      if (resumeSession.status === 'completed' && resumeSession.video) {
        uploadedVideo = resumeSession.video;
        resumeNotice.hidden = true;
        setStatus(uploadStatus, 'This video was already uploaded. You can start processing it now.', 'success');
      } else {
        uploadedVideo = null;
        resumeNotice.hidden = false;
        resumeNotice.textContent = 'Resumable upload found. ClipForge will continue from the bytes already received by the server.';
      }
    } else {
      currentUploadId = null;
      uploadedVideo = null;
      resumeNotice.hidden = true;
      clearSavedSession();
      uploadProgressWrap.hidden = true;
    }
    updateUploadButton();
    updateClipPreview();
  }

  function setUploadProgress(received, total) {
    const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
    uploadProgressWrap.hidden = false;
    uploadPercent.textContent = `${percent}%`;
    uploadProgressBar.style.width = `${percent}%`;
    uploadProgressDetail.textContent = `${formatBytes(received)} of ${formatBytes(total)} · You can retry if your connection drops.`;
  }

  function xhrUploadChunk(uploadId, blob, offset, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PATCH', `/api/uploads/${encodeURIComponent(uploadId)}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('Upload-Offset', String(offset));
      xhr.timeout = 180000;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded);
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) { /* no JSON body */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true, data });
        else if (xhr.status === 409) resolve({ conflict: true, offset: Number(data.offset), data });
        else reject(new Error(data.detail || `Chunk upload failed (${xhr.status}).`));
      };
      xhr.onerror = () => reject(new Error('Network connection interrupted while uploading a chunk.'));
      xhr.ontimeout = () => reject(new Error('This chunk took too long to upload. Retry to continue from the last saved byte.'));
      xhr.send(blob);
    });
  }

  async function getUploadState(uploadId) {
    return api(`/api/uploads/${encodeURIComponent(uploadId)}`);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function uploadFile() {
    if (!selectedFile || uploadBusy) return;
    uploadBusy = true;
    uploadButton.disabled = true;
    updateUploadButton();
    setStatus(uploadStatus, 'Preparing your upload…');

    try {
      let uploadId = currentUploadId;
      let state = null;
      if (uploadId) {
        try { state = await getUploadState(uploadId); }
        catch (_) { uploadId = null; currentUploadId = null; state = null; }
      }
      if (state && state.status === 'completed' && state.video) {
        currentUploadId = state.upload_id;
        uploadedVideo = state.video;
        saveSession({ uploadId: state.upload_id, filename: selectedFile.name, size: selectedFile.size, lastModified: selectedFile.lastModified, status: 'completed', video: state.video });
        onUploadCompleted(state.video);
        return;
      }
      if (!uploadId) {
        const session = await api('/api/uploads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: selectedFile.name, size: selectedFile.size, content_type: selectedFile.type || null, last_modified: selectedFile.lastModified || null }),
        });
        uploadId = session.upload_id;
        currentUploadId = uploadId;
        chunkBytes = session.chunk_bytes || chunkBytes;
        saveSession({ uploadId, filename: selectedFile.name, size: selectedFile.size, lastModified: selectedFile.lastModified, status: 'uploading' });
      }

      state = await getUploadState(uploadId);
      let offset = Number(state.received_bytes || 0);
      setUploadProgress(offset, selectedFile.size);
      uploadProgressLabel.textContent = offset > 0 ? 'Resuming upload…' : 'Uploading video…';
      let consecutiveFailures = 0;

      while (offset < selectedFile.size) {
        const end = Math.min(selectedFile.size, offset + chunkBytes);
        const chunk = selectedFile.slice(offset, end);
        try {
          const result = await xhrUploadChunk(uploadId, chunk, offset, (loaded) => {
            setUploadProgress(Math.min(selectedFile.size, offset + loaded), selectedFile.size);
          });
          if (result.conflict) {
            const latest = await getUploadState(uploadId);
            offset = Number(latest.received_bytes || 0);
            setUploadProgress(offset, selectedFile.size);
            consecutiveFailures = 0;
            continue;
          }
          offset = Number(result.data.received_bytes);
          setUploadProgress(offset, selectedFile.size);
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures += 1;
          try {
            const latest = await getUploadState(uploadId);
            const serverOffset = Number(latest.received_bytes || 0);
            if (serverOffset !== offset) {
              offset = serverOffset;
              setUploadProgress(offset, selectedFile.size);
              consecutiveFailures = 0;
              continue;
            }
          } catch (_) { /* The retry button can resume later if the server is temporarily unreachable. */ }
          if (consecutiveFailures >= 3) throw new Error(`${error.message} Press “Retry / resume upload” to try again without re-uploading saved chunks.`);
          uploadProgressLabel.textContent = `Connection hiccup · retry ${consecutiveFailures}/3`;
          await sleep(700 * consecutiveFailures);
        }
      }

      uploadProgressLabel.textContent = 'Verifying video…';
      uploadProgressDetail.textContent = 'Checking the video stream, duration and file integrity.';
      const completed = await api(`/api/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST' });
      currentUploadId = uploadId;
      uploadedVideo = completed.video;
      saveSession({ uploadId, filename: selectedFile.name, size: selectedFile.size, lastModified: selectedFile.lastModified, status: 'completed', video: completed.video });
      onUploadCompleted(completed.video);
    } catch (error) {
      setStatus(uploadStatus, error.message || 'Upload failed. Try again.', 'error');
      uploadProgressLabel.textContent = 'Upload paused';
      uploadProgressDetail.textContent = 'Your server-saved chunks are kept temporarily. Retry to resume where possible.';
      if (currentUploadId && selectedFile) {
        saveSession({ uploadId: currentUploadId, filename: selectedFile.name, size: selectedFile.size, lastModified: selectedFile.lastModified, status: 'uploading' });
      }
      uploadButtonText.textContent = 'Retry / resume upload';
    } finally {
      uploadBusy = false;
      updateUploadButton();
      updateClipPreview();
    }
  }

  function onUploadCompleted(video) {
    uploadedVideo = video;
    uploadProgressWrap.hidden = false;
    uploadProgressLabel.textContent = 'Upload complete';
    uploadPercent.textContent = '100%';
    uploadProgressBar.style.width = '100%';
    uploadProgressDetail.textContent = `${video.width || '?'} × ${video.height || '?'} px · ${formatDuration(Number(video.duration_seconds))} · ${video.has_audio ? 'Audio detected' : 'No audio stream detected'}`;
    resumeNotice.hidden = true;
    setStatus(uploadStatus, `Video verified · ${formatDuration(Number(video.duration_seconds))} total duration.`, 'success');
    updateUploadButton();
    updateClipPreview();
  }

  async function startProcessing() {
    if (startButton.disabled || processBusy || !currentUploadId || !uploadedVideo) return;
    const minutes = Number(clipMinutesInput.value);
    const formats = getSelectedFormats();
    if (!formats.length) {
      setStatus(startStatus, 'Select at least one output format.', 'error');
      return;
    }
    processBusy = true;
    updateStartButton();
    setStatus(startStatus, 'Creating processing job…');
    try {
      const job = await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_id: currentUploadId, clip_length_minutes: minutes, formats }),
      });
      currentJobId = job.id;
      jobCard.hidden = false;
      jobCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      clearSavedSession();
      selectedFile = null;
      uploadedVideo = null;
      currentUploadId = null;
      dropTitle.textContent = 'Processing your video';
      dropSubtitle.textContent = 'Your upload is being transformed into clips.';
      fileInfo.hidden = true;
      setStatus(uploadStatus, 'The source upload is now being processed.');
      setStatus(startStatus, '');
      await pollJob();
    } catch (error) {
      setStatus(startStatus, error.message || 'Could not start processing.', 'error');
    } finally {
      processBusy = false;
      updateUploadButton();
      updateStartButton();
    }
  }

  async function pollJob() {
    if (!currentJobId) return;
    if (pollingTimer) clearTimeout(pollingTimer);
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(currentJobId)}`);
      renderJob(job);
      if (['completed', 'completed_with_errors', 'failed'].includes(job.status)) {
        processBusy = false;
        updateUploadButton();
        updateStartButton();
        return;
      }
    } catch (error) {
      overallLabel.textContent = `Unable to refresh progress: ${error.message}`;
    }
    await sleep(1100);
    return pollJob();
  }

  function setStatusPill(status) {
    const labels = {
      queued: 'Queued', processing: 'Processing', completed: 'Complete',
      completed_with_errors: 'Complete with errors', failed: 'Failed',
    };
    jobStatusPill.textContent = labels[status] || status;
    jobStatusPill.className = `status-pill status-${status}`;
  }

  function renderJob(job) {
    const statusIsTerminal = ['completed', 'completed_with_errors', 'failed'].includes(job.status);
    const progress = Number(job.overall_progress || 0);
    const completed = job.summary?.completed || 0;
    const failed = job.summary?.failed || 0;
    const total = job.summary?.total || job.outputs.length;
    jobTitle.textContent = job.status === 'failed' ? 'Processing could not finish' : statusIsTerminal ? 'Your clips are ready' : 'Building your clips';
    jobSubtitle.textContent = `${job.filename} · ${formatDuration(Number(job.duration_seconds))} source · ${job.segment_count} segment${job.segment_count === 1 ? '' : 's'}`;
    setStatusPill(job.status);
    overallLabel.textContent = statusIsTerminal ? 'Processing finished' : 'Rendering clips and formats…';
    overallPercent.textContent = `${Math.round(progress)}%`;
    overallProgressBar.style.width = `${progress}%`;
    jobOutputCounts.textContent = `${completed + failed} of ${total} outputs finished · ${completed} successful${failed ? ` · ${failed} failed` : ''}`;
    jobClipCountLabel.textContent = `${job.segment_count} segment${job.segment_count === 1 ? '' : 's'} · ${job.formats.length} format${job.formats.length === 1 ? '' : 's'}`;

    outputList.replaceChildren();
    job.outputs.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'output-row';
      const top = document.createElement('div');
      top.className = 'output-row-top';
      const name = document.createElement('div');
      name.className = 'output-name';
      const title = document.createElement('strong');
      title.textContent = `part${item.part}.mp4`;
      const subtitle = document.createElement('small');
      subtitle.textContent = `${item.format_label} · ${formatDuration(Number(item.duration_seconds))}`;
      name.append(title, subtitle);
      const state = document.createElement('span');
      state.className = `output-state state-${item.status}`;
      const stateLabels = { queued: 'Queued', processing: 'Rendering', completed: 'Done', failed: 'Failed' };
      state.textContent = stateLabels[item.status] || item.status;
      top.append(name, state);
      const track = document.createElement('div');
      track.className = 'progress-track';
      const fill = document.createElement('div');
      fill.className = 'progress-fill';
      const rowProgress = item.status === 'completed' ? 100 : item.status === 'failed' ? 100 : Number(item.progress || 0);
      fill.style.width = `${rowProgress}%`;
      if (item.status === 'completed') fill.classList.add('done');
      if (item.status === 'failed') fill.classList.add('failed');
      track.append(fill);
      row.append(top, track);
      if (item.status === 'failed' && item.error) {
        const error = document.createElement('p');
        error.className = 'output-error';
        error.textContent = item.error;
        row.append(error);
      }
      outputList.append(row);
    });

    if (job.failures?.length) {
      jobFailures.hidden = false;
      jobFailures.textContent = `${job.failures.length} output${job.failures.length === 1 ? '' : 's'} failed. The ZIP will include every clip that succeeded; the failed items are listed above.`;
    } else {
      jobFailures.hidden = true;
      jobFailures.textContent = '';
    }

    if (job.status === 'failed' && job.error) {
      jobFailures.hidden = false;
      jobFailures.textContent = job.error;
    }

    downloadPanel.hidden = !job.download_available;
    if (job.download_available) {
      downloadButton.href = `/api/jobs/${encodeURIComponent(job.id)}/download`;
      downloadDescription.textContent = `${completed} successful file${completed === 1 ? '' : 's'} grouped in format folders${failed ? ` · ${failed} failed output${failed === 1 ? '' : 's'} skipped` : ''}. The ZIP is removed from the server after download.`;
    }
  }

  async function restoreSession() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { saved = null; }
    if (!saved?.uploadId) return;
    try {
      const state = await getUploadState(saved.uploadId);
      resumeSession = {
        uploadId: saved.uploadId,
        filename: state.filename || saved.filename,
        size: Number(state.size || saved.size),
        lastModified: saved.lastModified,
        status: state.status,
        video: state.video || saved.video,
      };
      currentUploadId = state.upload_id;
      if (state.status === 'completed' && state.video) {
        uploadedVideo = state.video;
        dropTitle.textContent = state.filename;
        dropSubtitle.textContent = `${formatBytes(state.size)} · Previously uploaded`;
        fileInfo.hidden = false;
        fileInfo.textContent = `${state.filename} · ${formatBytes(state.size)}`;
        uploadProgressWrap.hidden = false;
        uploadProgressLabel.textContent = 'Upload complete';
        uploadPercent.textContent = '100%';
        uploadProgressBar.style.width = '100%';
        uploadProgressDetail.textContent = `${state.video.width || '?'} × ${state.video.height || '?'} px · ${formatDuration(Number(state.video.duration_seconds))}`;
        saveSession({ ...resumeSession, status: 'completed', video: state.video });
        setStatus(uploadStatus, 'Restored a previously uploaded video from this browser.', 'success');
      } else {
        resumeNotice.hidden = false;
        resumeNotice.textContent = `An interrupted upload for “${state.filename}” is saved on the server (${formatBytes(state.received_bytes)} of ${formatBytes(state.size)}). Select the same file to resume.`;
        saveSession({ ...resumeSession, status: 'uploading' });
      }
    } catch (_) {
      clearSavedSession();
    }
    updateUploadButton();
    updateClipPreview();
  }

  async function initialize() {
    try {
      const health = await api('/api/health');
      maxUploadBytes = Number(health.max_upload_bytes || fallbackMaxBytes);
      chunkBytes = Number(health.chunk_bytes || CHUNK_FALLBACK);
      serverReady = Boolean(health.ffmpeg_available && health.ffprobe_available);
      dropSubtitle.textContent = `MP4, MOV, MKV, WEBM and more · up to ${formatBytes(maxUploadBytes)} per file`;
      if (!serverReady) {
        setStatus(startStatus, 'FFmpeg/FFprobe is not installed or not on PATH on the server. Install FFmpeg, then refresh this page.', 'error');
      }
    } catch (error) {
      serverReady = false;
      setStatus(startStatus, `Could not connect to the server: ${error.message}`, 'error');
    }
    await restoreSession();
    updateUploadButton();
    updateStartButton();
  }

  videoInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) selectFile(file);
  });
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      videoInput.click();
    }
  });
  ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
  }));
  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) selectFile(file);
  });
  uploadButton.addEventListener('click', uploadFile);
  clipMinutesInput.addEventListener('input', updateClipPreview);
  formatGrid.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener('change', updateFormatCards));
  startButton.addEventListener('click', startProcessing);
  downloadButton.addEventListener('click', () => {
    downloadButton.style.pointerEvents = 'none';
    downloadButton.style.opacity = '0.68';
    downloadButton.setAttribute('aria-disabled', 'true');
    downloadButton.querySelector('span').textContent = 'Download started';
    downloadDescription.textContent = 'Your ZIP download has been requested. The server removes the ZIP after the response is sent.';
  });

  initialize();
})();
