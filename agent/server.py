"""FastAPI server for the AI Sports Commentator.

Endpoints:
- POST /api/start   — Download a YouTube video and return session info
- WS   /ws/{session_id} — Stream commentary (text + TTS audio) over WebSocket
- GET  /api/health   — Health check
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from agent.config import config
from agent.pipeline import CommentaryPipeline, LiveCommentaryPipeline, get_or_load_model
from agent.video_download import VideoInfo, download_video

logger = logging.getLogger(__name__)

app = FastAPI(title="AI Sports Commentator")

# CORS for frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session store: session_id -> VideoInfo
_sessions: dict[str, VideoInfo] = {}

# Active pipelines for cleanup
_active_pipelines: dict[str, CommentaryPipeline] = {}


# ---- Models ----


class StartRequest(BaseModel):
    url: str


class StartResponse(BaseModel):
    session_id: str
    title: str
    duration: int
    video_url: str


# ---- Endpoints ----


@app.on_event("startup")
async def startup():
    """Pre-load the RF-DETR model on server start so first request is fast."""
    videos_dir = Path(config.videos_dir)
    videos_dir.mkdir(parents=True, exist_ok=True)

    # Mount videos directory for static serving
    app.mount("/videos", StaticFiles(directory=str(videos_dir)), name="videos")

    logger.info("Starting RF-DETR model warmup...")
    await get_or_load_model()
    logger.info("RF-DETR model ready. Server is live.")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.post("/api/start", response_model=StartResponse)
async def start_commentary(req: StartRequest):
    """Download a YouTube video and return a session for WebSocket commentary."""
    video = await download_video(
        url=req.url,
        output_dir=config.videos_dir,
        max_duration=config.max_video_duration,
    )

    session_id = str(uuid.uuid4())[:8]
    _sessions[session_id] = video

    logger.info("Session %s created for: %s (%ds)", session_id, video.title, video.duration)

    return StartResponse(
        session_id=session_id,
        title=video.title,
        duration=video.duration,
        video_url=f"/videos/{video.path.name}",
    )


@app.websocket("/ws/{session_id}")
async def commentary_ws(ws: WebSocket, session_id: str):
    """WebSocket endpoint that streams commentary for a session."""
    video = _sessions.get(session_id)
    if video is None:
        await ws.close(code=4004, reason="Session not found")
        return

    # If there's already an active pipeline for this session (e.g. React StrictMode
    # double-mount), stop it before starting a new one.
    existing = _active_pipelines.pop(session_id, None)
    if existing is not None:
        logger.info("Replacing existing pipeline for session %s", session_id)
        await existing.stop()

    await ws.accept()
    logger.info("WebSocket connected for session %s", session_id)

    pipeline = CommentaryPipeline(ws=ws, video_path=video.path)
    _active_pipelines[session_id] = pipeline

    try:
        await pipeline.run()
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected for session %s", session_id)
    finally:
        await pipeline.stop()
        _active_pipelines.pop(session_id, None)
        logger.info("Pipeline stopped for session %s", session_id)


# ---- Live streaming endpoint (Chrome Extension) ----

# Active live pipelines for cleanup
_active_live_pipelines: dict[str, LiveCommentaryPipeline] = {}


@app.websocket("/ws/live")
async def live_commentary_ws(ws: WebSocket):
    """WebSocket for Chrome Extension: receives JPEG frames, streams commentary back."""
    await ws.accept()
    session_id = str(uuid.uuid4())[:8]
    logger.info("Live WebSocket connected: session %s", session_id)

    pipeline = LiveCommentaryPipeline(ws=ws)
    _active_live_pipelines[session_id] = pipeline

    try:
        await pipeline.initialize()

        while True:
            message = await ws.receive()

            if message.get("type") == "websocket.disconnect":
                break

            # Binary message = JPEG frame
            if "bytes" in message and message["bytes"]:
                await pipeline.process_frame(message["bytes"])

            # Text message = JSON command
            elif "text" in message and message["text"]:
                import json

                data = json.loads(message["text"])
                if data.get("type") == "stop":
                    logger.info("Client requested stop for live session %s", session_id)
                    break

    except WebSocketDisconnect:
        logger.info("Live WebSocket disconnected: session %s", session_id)
    except Exception:
        logger.exception("Error in live commentary session %s", session_id)
    finally:
        await pipeline.stop()
        _active_live_pipelines.pop(session_id, None)
        logger.info("Live pipeline stopped: session %s", session_id)


# ---- Entry point ----

if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-8s | %(message)s")
    uvicorn.run(app, host="0.0.0.0", port=config.server_port)
