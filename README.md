# Video Clipper

<p align="center">
  <img src="assets/logo.svg" alt="Video Clipper logo" width="160">
</p>

<p align="center">
  Upload one long-form video, split it into clips, reformat each clip for multiple platforms, and download one organized ZIP.
</p>

## Features

- Resumable browser uploads in 4 MB chunks.
- Supported input formats: MP4, MOV, MKV, WebM, AVI, M4V, MPG, and MPEG.
- Configurable upload-size and duration limits.
- Clip lengths up to 30 minutes per segment.
- Five output formats:
  - Reel / vertical — 9:16
  - Video / landscape — 16:9
  - Square — 1:1
  - Portrait — 4:5
  - Classic — 4:3
- Letterboxes or pillarboxes video instead of cropping it.
- Server-sent events (SSE) show per-clip processing progress.
- A failed clip is reported without stopping the remaining clips.
- One ZIP download with format folders such as `reel/part1.mp4` and `video/part1.mp4`.
- Bundled FFmpeg and FFprobe binaries; a system FFmpeg installation is not required.

## Requirements

- Node.js 18 or newer
- npm
- Enough disk space for the source video, generated clips, and ZIP archive

## Quick start

```bash
git clone https://github.com/karthi11040/video-clipper.git
cd video-clipper
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in a browser.

`npm install` downloads the platform-specific `ffmpeg-static` and `ffprobe-static`
packages. The application creates temporary processing data in `jobs/`; this
directory is ignored by Git.

## Configuration

Set environment variables before starting the server:

| Variable | Default | Description |
| --- | ---: | --- |
| `PORT` | `3000` | HTTP port |
| `MAX_UPLOAD_MB` | `1024` | Maximum source-file size in MB |
| `MAX_DURATION_SEC` | `14400` | Maximum source duration in seconds (4 hours) |

PowerShell:

```powershell
$env:PORT = "3000"
$env:MAX_UPLOAD_MB = "2048"
$env:MAX_DURATION_SEC = "28800"
npm start
```

## How it works

1. The browser calls `POST /api/upload/init`. The server validates the file extension and size and returns a job ID.
2. The browser uploads 4 MB chunks to `POST /api/upload/:jobId/chunk`. Completed chunk indexes are stored in `localStorage`, so interrupted uploads can resume.
3. `POST /api/upload/:jobId/complete` joins the chunks and uses FFprobe to verify the authoritative duration.
4. `POST /api/jobs/:jobId/process` splits the source into sequential segments and transcodes each selected aspect ratio with FFmpeg.
5. The browser listens to `GET /api/jobs/:jobId/events` for `part-start`, `progress`, `part-done`, `part-failed`, and `job-done` events.
6. `GET /api/jobs/:jobId/download` streams the ZIP and removes the completed job afterward.

The server uses input seeking, H.264 (`veryfast`, CRF 22), AAC audio, and
`scale + pad + setsar=1` filters. The original content is fitted inside each
target frame, so the video is not cropped.

## API summary

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Read limits, supported formats, and chunk size |
| `POST` | `/api/upload/init` | Create a resumable upload job |
| `POST` | `/api/upload/:jobId/chunk?index=N` | Upload one multipart chunk (`chunk` field) |
| `POST` | `/api/upload/:jobId/complete` | Join chunks and validate duration |
| `POST` | `/api/jobs/:jobId/process` | Process with `{ "maxLenSec": 60, "formats": ["reel", "video"] }` |
| `GET` | `/api/jobs/:jobId/events` | Subscribe to processing events over SSE |
| `GET` | `/api/jobs/:jobId/download` | Download the generated ZIP |

## Project structure

```text
server.js       Express API, upload lifecycle, FFmpeg processing, and ZIP creation
public/         Browser UI and client-side upload/progress logic
assets/logo.svg Repository logo
jobs/           Runtime job data (created automatically and ignored by Git)
```

## Operational notes

- Jobs are held in memory and are local to one server process. This is suitable
  for local use or a single-instance deployment, not a multi-instance service.
- Uploaded and generated media is temporary and is deleted after download; an
  abandoned-job sweeper removes old jobs after two hours.
- There is no authentication or access control. Do not expose this service
  directly to the public internet without adding authentication, rate limiting,
  HTTPS, and storage isolation.
- Large videos require both temporary disk space and enough CPU time to encode
  every selected format.

## Troubleshooting

### `npm install` fails while installing FFmpeg

Check that Node.js and npm are up to date, then remove `node_modules` and
`package-lock.json` only if you are intentionally refreshing dependencies.
Run `npm install` again on the target operating system so the correct optional
binary package is installed.

### The browser cannot connect

Confirm that `npm start` is still running and that the browser URL uses the
configured `PORT`. On another device, bind the server through a suitable
reverse proxy rather than exposing an unauthenticated development server.

### A clip fails

The UI reports the failed format and part while continuing the job. Check the
server output for the FFmpeg error and try a supported input format or a
shorter source clip.

## Contributing

1. Create a branch for your change.
2. Keep behavior changes focused and update this README when the setup or API changes.
3. Run `npm start` and exercise a small test video before opening a pull request.
4. Do not commit `node_modules`, runtime media, `.env` files, or secrets.

## License

No license has been selected yet. Add a `LICENSE` file before distributing this
project or accepting external contributions.
