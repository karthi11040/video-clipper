from __future__ import annotations

import asyncio
import json
import math
import os
import shutil
import subprocess
import time
import uuid
import zipfile
from contextlib import suppress
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data"))).resolve()
VERSION = (BASE_DIR / "VERSION").read_text(encoding="utf-8").strip()
UPLOADS_DIR = DATA_DIR / "uploads"
JOBS_DIR = DATA_DIR / "jobs"

MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(3 * 1024 * 1024 * 1024)))
MAX_DURATION_SECONDS = int(os.getenv("MAX_DURATION_SECONDS", str(3 * 60 * 60)))
CHUNK_BYTES = int(os.getenv("CHUNK_BYTES", str(8 * 1024 * 1024)))
UPLOAD_TTL_SECONDS = int(os.getenv("UPLOAD_TTL_SECONDS", str(24 * 60 * 60)))
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", str(6 * 60 * 60)))

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mpeg", ".mpg", ".3gp", ".wmv", ".ts"}

FORMAT_SPECS: dict[str, dict[str, Any]] = {
    "reel": {"label": "Reel / vertical", "width": 1080, "height": 1920, "mode": "contain"},
    "video": {"label": "Video / landscape", "width": 1920, "height": 1080, "mode": "contain"},
    "square": {"label": "Square", "width": 1080, "height": 1080, "mode": "crop"},
    "portrait45": {"label": "Portrait 4:5", "width": 1080, "height": 1350, "mode": "contain"},
    "classic43": {"label": "Classic 4:3", "width": 1440, "height": 1080, "mode": "contain"},
}

UPLOAD_LOCKS: dict[str, asyncio.Lock] = {}
ACTIVE_UPLOAD_IDS: set[str] = set()
JOBS: dict[str, dict[str, Any]] = {}
HOUSEKEEPER_TASK: asyncio.Task | None = None


def _now() -> float:
    return time.time()


def _upload_dir(upload_id: str) -> Path:
    return UPLOADS_DIR / upload_id


def _job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=404, detail="Upload session was not found or is no longer available.") from exc


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")
    temporary.replace(path)


def _get_upload_metadata(upload_id: str) -> dict[str, Any]:
    if not upload_id or any(ch not in "0123456789abcdef-" for ch in upload_id.lower()):
        raise HTTPException(status_code=404, detail="Upload session was not found.")
    return _read_json(_upload_dir(upload_id) / "metadata.json")


def _probe_media(path: Path) -> dict[str, Any]:
    if shutil.which("ffprobe") is None:
        raise RuntimeError("ffprobe was not found. Install FFmpeg and make sure ffprobe is on PATH.")

    command = [
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration,format_name:stream=codec_type,width,height,duration",
        "-of", "json", str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=90, check=False)
    if result.returncode != 0:
        raise ValueError("The file could not be read as a supported video. Try exporting it as MP4 (H.264/AAC).")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("FFprobe could not read the video's metadata.") from exc

    streams = payload.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    if not video_streams:
        raise ValueError("The uploaded file does not contain a video stream.")

    format_data = payload.get("format") or {}
    durations: list[float] = []
    for value in [format_data.get("duration")] + [stream.get("duration") for stream in streams]:
        try:
            number = float(value)
            if math.isfinite(number) and number > 0:
                durations.append(number)
        except (TypeError, ValueError):
            pass
    if not durations:
        raise ValueError("The video duration could not be detected. Try re-exporting the file as MP4.")

    duration = max(durations)
    if duration > MAX_DURATION_SECONDS:
        maximum_minutes = MAX_DURATION_SECONDS // 60
        raise ValueError(
            f"This instance accepts videos up to {maximum_minutes} minutes long. "
            "Choose a shorter file or increase MAX_DURATION_SECONDS on a server with enough resources."
        )

    first_video = video_streams[0]
    return {
        "duration_seconds": duration,
        "width": first_video.get("width"),
        "height": first_video.get("height"),
        "format_name": format_data.get("format_name", "unknown"),
        "has_audio": any(stream.get("codec_type") == "audio" for stream in streams),
    }


def _safe_original_name(value: str) -> str:
    # Strip both POSIX and Windows path components; never trust a client-supplied path.
    name = (value or "video").replace("\\", "/").split("/")[-1].strip()
    return name[:180] or "video"


class UploadInit(BaseModel):
    filename: str = Field(min_length=1, max_length=500)
    size: int = Field(ge=1)
    content_type: str | None = None
    last_modified: int | None = None


class CreateJob(BaseModel):
    upload_id: str
    clip_length_minutes: int = Field(ge=1, le=30)
    formats: list[str] = Field(min_length=1)


app = FastAPI(title="ClipForge", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
async def startup() -> None:
    global HOUSEKEEPER_TASK
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    HOUSEKEEPER_TASK = asyncio.create_task(_housekeeping_loop())


@app.on_event("shutdown")
async def shutdown() -> None:
    global HOUSEKEEPER_TASK
    if HOUSEKEEPER_TASK:
        HOUSEKEEPER_TASK.cancel()
        with suppress(asyncio.CancelledError):
            await HOUSEKEEPER_TASK


@app.get("/", response_class=HTMLResponse)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "version": VERSION,
        "ffmpeg_available": shutil.which("ffmpeg") is not None,
        "ffprobe_available": shutil.which("ffprobe") is not None,
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "max_duration_seconds": MAX_DURATION_SECONDS,
        "chunk_bytes": CHUNK_BYTES,
    }


@app.post("/api/uploads", status_code=201)
async def create_upload(payload: UploadInit) -> dict[str, Any]:
    filename = _safe_original_name(payload.filename)
    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise HTTPException(status_code=415, detail=f"Unsupported video file type. Supported extensions: {allowed}.")
    if payload.size > MAX_UPLOAD_BYTES:
        maximum_gb = MAX_UPLOAD_BYTES / (1024 ** 3)
        raise HTTPException(
            status_code=413,
            detail=f"This instance limits uploads to {maximum_gb:.1f} GB. Choose a smaller file or raise MAX_UPLOAD_BYTES on a server with sufficient disk space.",
        )

    upload_id = str(uuid.uuid4())
    folder = _upload_dir(upload_id)
    folder.mkdir(parents=True, exist_ok=False)
    metadata = {
        "id": upload_id,
        "filename": filename,
        "extension": extension,
        "size": payload.size,
        "content_type": payload.content_type,
        "last_modified": payload.last_modified,
        "received_bytes": 0,
        "status": "uploading",
        "created_at": _now(),
        "updated_at": _now(),
    }
    _write_json(folder / "metadata.json", metadata)
    (folder / "upload.part").touch()
    UPLOAD_LOCKS[upload_id] = asyncio.Lock()
    return {"upload_id": upload_id, "chunk_bytes": CHUNK_BYTES, "received_bytes": 0, "size": payload.size}


@app.get("/api/uploads/{upload_id}")
async def get_upload(upload_id: str) -> dict[str, Any]:
    metadata = _get_upload_metadata(upload_id)
    return {
        "upload_id": upload_id,
        "filename": metadata["filename"],
        "size": metadata["size"],
        "received_bytes": metadata["received_bytes"],
        "status": metadata["status"],
        "video": metadata.get("video"),
        "updated_at": metadata.get("updated_at"),
    }


@app.patch("/api/uploads/{upload_id}")
async def append_upload_chunk(
    upload_id: str,
    request: Request,
    upload_offset: int | None = Header(default=None, alias="Upload-Offset"),
) -> dict[str, Any]:
    metadata = _get_upload_metadata(upload_id)
    if metadata.get("status") != "uploading":
        raise HTTPException(status_code=409, detail="This upload is no longer accepting chunks.")
    if upload_offset is None or upload_offset < 0:
        raise HTTPException(status_code=400, detail="Upload-Offset header is required.")

    chunk = await request.body()
    if not chunk:
        raise HTTPException(status_code=400, detail="Empty upload chunk.")
    if len(chunk) > CHUNK_BYTES:
        raise HTTPException(status_code=413, detail=f"Chunk is too large. Maximum chunk size is {CHUNK_BYTES} bytes.")

    lock = UPLOAD_LOCKS.setdefault(upload_id, asyncio.Lock())
    async with lock:
        # Re-read inside the lock to avoid offset races from duplicate/retried requests.
        metadata = _get_upload_metadata(upload_id)
        current = int(metadata["received_bytes"])
        if upload_offset != current:
            return JSONResponse(
                status_code=409,
                content={"detail": "Upload offset mismatch; resume from the server offset.", "offset": current},
            )
        if current + len(chunk) > int(metadata["size"]):
            raise HTTPException(status_code=413, detail="Chunk would exceed the declared file size.")

        part_path = _upload_dir(upload_id) / "upload.part"
        await asyncio.to_thread(_append_bytes, part_path, chunk)
        metadata["received_bytes"] = current + len(chunk)
        metadata["updated_at"] = _now()
        _write_json(_upload_dir(upload_id) / "metadata.json", metadata)
        return {"upload_id": upload_id, "received_bytes": metadata["received_bytes"], "size": metadata["size"]}


def _append_bytes(path: Path, chunk: bytes) -> None:
    with path.open("ab") as handle:
        handle.write(chunk)
        handle.flush()


@app.post("/api/uploads/{upload_id}/complete")
async def complete_upload(upload_id: str) -> dict[str, Any]:
    lock = UPLOAD_LOCKS.setdefault(upload_id, asyncio.Lock())
    async with lock:
        metadata = _get_upload_metadata(upload_id)
        if metadata.get("status") == "completed":
            return {"upload_id": upload_id, "status": "completed", "video": metadata.get("video")}
        if metadata.get("status") != "uploading":
            raise HTTPException(status_code=409, detail="This upload cannot be completed.")
        if int(metadata["received_bytes"]) != int(metadata["size"]):
            raise HTTPException(status_code=409, detail="Upload is incomplete. Resume uploading the remaining bytes.")
        part_path = _upload_dir(upload_id) / "upload.part"
        source_path = _upload_dir(upload_id) / f"source{metadata['extension']}"
        part_path.replace(source_path)
        try:
            video = await asyncio.to_thread(_probe_media, source_path)
        except (ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
            shutil.rmtree(_upload_dir(upload_id), ignore_errors=True)
            UPLOAD_LOCKS.pop(upload_id, None)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        metadata["status"] = "completed"
        metadata["video"] = video
        metadata["source_filename"] = source_path.name
        metadata["updated_at"] = _now()
        _write_json(_upload_dir(upload_id) / "metadata.json", metadata)
        return {"upload_id": upload_id, "status": "completed", "video": video}


@app.delete("/api/uploads/{upload_id}")
async def delete_upload(upload_id: str) -> dict[str, bool]:
    _get_upload_metadata(upload_id)
    if upload_id in ACTIVE_UPLOAD_IDS:
        raise HTTPException(status_code=409, detail="This upload is currently being processed.")
    shutil.rmtree(_upload_dir(upload_id), ignore_errors=True)
    UPLOAD_LOCKS.pop(upload_id, None)
    return {"deleted": True}


@app.post("/api/jobs", status_code=202)
async def create_job(payload: CreateJob) -> dict[str, Any]:
    unknown = [name for name in payload.formats if name not in FORMAT_SPECS]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown output format(s): {', '.join(unknown)}")
    formats = list(dict.fromkeys(payload.formats))
    if not formats:
        raise HTTPException(status_code=422, detail="Select at least one output format.")

    metadata = _get_upload_metadata(payload.upload_id)
    if metadata.get("status") != "completed":
        raise HTTPException(status_code=409, detail="Upload the complete video before starting a job.")
    if any(job.get("status") in {"queued", "processing"} for job in JOBS.values()):
        raise HTTPException(status_code=409, detail="Another job is already processing on this server. Wait for it to finish first.")

    source_path = _upload_dir(payload.upload_id) / metadata["source_filename"]
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="The uploaded source is no longer available. Please upload it again.")

    duration = float(metadata["video"]["duration_seconds"])
    clip_seconds = payload.clip_length_minutes * 60
    segment_count = max(1, math.ceil(duration / clip_seconds))
    job_id = str(uuid.uuid4())
    job_folder = _job_dir(job_id)
    (job_folder / "rendered").mkdir(parents=True, exist_ok=True)

    outputs = []
    for part in range(1, segment_count + 1):
        start = (part - 1) * clip_seconds
        segment_duration = min(float(clip_seconds), max(0.0, duration - start))
        for fmt in formats:
            outputs.append({
                "part": part,
                "format": fmt,
                "format_label": FORMAT_SPECS[fmt]["label"],
                "duration_seconds": segment_duration,
                "status": "queued",
                "progress": 0,
                "error": None,
            })

    job = {
        "id": job_id,
        "upload_id": payload.upload_id,
        "filename": metadata["filename"],
        "duration_seconds": duration,
        "clip_length_seconds": clip_seconds,
        "segment_count": segment_count,
        "formats": formats,
        "outputs": outputs,
        "status": "queued",
        "created_at": _now(),
        "updated_at": _now(),
        "error": None,
        "failures": [],
        "download_available": False,
        "downloaded": False,
    }
    JOBS[job_id] = job
    ACTIVE_UPLOAD_IDS.add(payload.upload_id)
    asyncio.create_task(_process_job(job_id, source_path))
    return _serialize_job(job)


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job was not found. Jobs are kept temporarily in this demo server.")
    return _serialize_job(job)


def _serialize_job(job: dict[str, Any]) -> dict[str, Any]:
    outputs = job["outputs"]
    terminal = sum(1 for item in outputs if item["status"] in {"completed", "failed"})
    active_progress = sum(
        float(item.get("progress", 0)) / 100.0
        for item in outputs if item["status"] == "processing"
    )
    overall = ((terminal + active_progress) / len(outputs) * 100.0) if outputs else 100.0
    return {
        "id": job["id"],
        "filename": job["filename"],
        "duration_seconds": job["duration_seconds"],
        "clip_length_seconds": job["clip_length_seconds"],
        "segment_count": job["segment_count"],
        "formats": job["formats"],
        "outputs": job["outputs"],
        "status": job["status"],
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
        "overall_progress": round(min(100.0, overall), 1),
        "failures": job["failures"],
        "error": job["error"],
        "download_available": job["download_available"] and (_job_dir(job["id"]) / "clips.zip").exists(),
        "summary": {
            "completed": sum(1 for item in outputs if item["status"] == "completed"),
            "failed": sum(1 for item in outputs if item["status"] == "failed"),
            "total": len(outputs),
        },
    }


@app.get("/api/jobs/{job_id}/download")
async def download_job(job_id: str) -> FileResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job was not found or has expired.")
    zip_path = _job_dir(job_id) / "clips.zip"
    if not zip_path.exists() or not job.get("download_available"):
        raise HTTPException(status_code=409, detail="The ZIP is not ready or has already been downloaded.")

    job["downloaded"] = True
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"clipforge_{job_id[:8]}.zip",
        background=BackgroundTask(_cleanup_after_download, job_id),
    )


def _cleanup_after_download(job_id: str) -> None:
    shutil.rmtree(_job_dir(job_id), ignore_errors=True)
    job = JOBS.get(job_id)
    if job:
        job["download_available"] = False
        job["downloaded"] = True
        job["updated_at"] = _now()


async def _process_job(job_id: str, source_path: Path) -> None:
    job = JOBS[job_id]
    job["status"] = "processing"
    job["updated_at"] = _now()
    rendered_dir = _job_dir(job_id) / "rendered"
    zip_path = _job_dir(job_id) / "clips.zip"

    try:
        for item in job["outputs"]:
            fmt = item["format"]
            part = item["part"]
            spec = FORMAT_SPECS[fmt]
            start = (part - 1) * job["clip_length_seconds"]
            duration = float(item["duration_seconds"])
            format_dir = rendered_dir / fmt
            format_dir.mkdir(parents=True, exist_ok=True)
            output_path = format_dir / f"part{part}.mp4"

            item["status"] = "processing"
            item["progress"] = 0
            item["started_at"] = _now()
            job["updated_at"] = _now()

            try:
                video_filter = _video_filter(spec)
                command = [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-nostdin",
                    "-progress", "pipe:1", "-stats_period", "0.25",
                    "-ss", f"{start:.6f}", "-i", str(source_path), "-t", f"{duration:.6f}",
                    "-map", "0:v:0", "-map", "0:a?", "-vf", video_filter,
                    "-c:v", "libx264", "-preset", os.getenv("FFMPEG_PRESET", "veryfast"),
                    "-crf", os.getenv("FFMPEG_CRF", "23"), "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "160k", "-fps_mode", "passthrough",
                    "-movflags", "+faststart", str(output_path),
                ]

                async def update_progress(value: float) -> None:
                    item["progress"] = max(0, min(99, int(value * 100)))
                    job["updated_at"] = _now()

                await _run_ffmpeg(command, duration, update_progress)
                if not output_path.exists() or output_path.stat().st_size < 1024:
                    raise RuntimeError("FFmpeg finished but the output file is missing or unexpectedly small.")
                item["status"] = "completed"
                item["progress"] = 100
                item["output_bytes"] = output_path.stat().st_size
                item["completed_at"] = _now()
            except Exception as exc:  # A failed output must not stop remaining formats/parts.
                with suppress(OSError):
                    output_path.unlink()
                item["status"] = "failed"
                item["progress"] = 0
                item["error"] = _brief_error(str(exc))
                item["completed_at"] = _now()
                job["failures"].append({
                    "part": part,
                    "format": fmt,
                    "message": item["error"],
                })
            finally:
                job["updated_at"] = _now()

        success_items = [item for item in job["outputs"] if item["status"] == "completed"]
        if not success_items:
            job["status"] = "failed"
            job["error"] = "No clips were created successfully. Check FFmpeg and server logs, then try another source video."
            return

        with zipfile.ZipFile(zip_path, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
            for item in success_items:
                file_path = rendered_dir / item["format"] / f"part{item['part']}.mp4"
                if file_path.exists():
                    archive.write(file_path, arcname=f"{item['format']}/part{item['part']}.mp4")

        # Rendered MP4 files and the uploaded source are temporary; ZIP is the deliverable.
        shutil.rmtree(rendered_dir, ignore_errors=True)
        job["download_available"] = zip_path.exists() and zip_path.stat().st_size > 0
        job["status"] = "completed_with_errors" if job["failures"] else "completed"
        job["updated_at"] = _now()
    except Exception as exc:
        job["status"] = "failed"
        job["error"] = _brief_error(str(exc))
        job["updated_at"] = _now()
    finally:
        ACTIVE_UPLOAD_IDS.discard(job.get("upload_id", ""))
        shutil.rmtree(_upload_dir(job.get("upload_id", "")), ignore_errors=True)
        UPLOAD_LOCKS.pop(job.get("upload_id", ""), None)


def _video_filter(spec: dict[str, Any]) -> str:
    width, height = spec["width"], spec["height"]
    if spec["mode"] == "crop":
        # Square output uses a centered crop. This fills the frame without bars.
        return f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1"
    # Contain the complete source frame and fill unused space with black bars.
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
    )


async def _run_ffmpeg(command: list[str], duration: float, on_progress) -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg was not found. Install FFmpeg and make sure it is on PATH.")
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert process.stdout is not None and process.stderr is not None
    stderr_task = asyncio.create_task(process.stderr.read())
    latest_us = 0
    while True:
        raw_line = await process.stdout.readline()
        if not raw_line:
            break
        line = raw_line.decode("utf-8", errors="replace").strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key == "out_time_us":
            with suppress(ValueError):
                latest_us = max(0, int(value))
                await on_progress(min(0.999, latest_us / max(1.0, duration * 1_000_000)))
        elif key == "progress" and value == "end":
            await on_progress(0.999)

    return_code = await process.wait()
    stderr_bytes = await stderr_task
    if return_code != 0:
        message = stderr_bytes.decode("utf-8", errors="replace").strip()
        raise RuntimeError(message[-1200:] or f"FFmpeg exited with code {return_code}.")


def _brief_error(message: str) -> str:
    cleaned = " ".join((message or "Processing failed.").split())
    return cleaned[:500]


async def _housekeeping_loop() -> None:
    while True:
        try:
            now = _now()
            if UPLOADS_DIR.exists():
                for folder in UPLOADS_DIR.iterdir():
                    if not folder.is_dir() or folder.name in ACTIVE_UPLOAD_IDS:
                        continue
                    meta_path = folder / "metadata.json"
                    try:
                        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
                        age = now - float(metadata.get("updated_at", metadata.get("created_at", now)))
                    except (OSError, ValueError, json.JSONDecodeError):
                        age = UPLOAD_TTL_SECONDS + 1
                    if age > UPLOAD_TTL_SECONDS:
                        shutil.rmtree(folder, ignore_errors=True)
                        UPLOAD_LOCKS.pop(folder.name, None)
            for job_id, job in list(JOBS.items()):
                if job.get("status") in {"queued", "processing"}:
                    continue
                if now - float(job.get("updated_at", now)) > JOB_TTL_SECONDS:
                    shutil.rmtree(_job_dir(job_id), ignore_errors=True)
                    job["download_available"] = False
            await asyncio.sleep(15 * 60)
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(60)
