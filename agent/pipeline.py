"""Standalone commentary pipeline: video → detection → LLM → TTS → WebSocket.

Bypasses Stream SFU entirely. Uses VideoFileTrack for frame reading, RF-DETR
for detection, Claude for commentary, and Cartesia for TTS. Streams results
to the browser over a WebSocket.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import av
import numpy as np
import supervision as sv
from anthropic import AsyncAnthropic
from cartesia import AsyncCartesia
from fastapi import WebSocket, WebSocketDisconnect
from vision_agents.core.utils.video_track import VideoFileTrack

from agent.config import config
from agent.processors.events import DetectedObject

logger = logging.getLogger(__name__)

# Load instructions once at module level
_INSTRUCTIONS_PATH = Path(__file__).parent / "instructions" / "commentary.md"
INSTRUCTIONS = _INSTRUCTIONS_PATH.read_text()

COMMENTARY_PROMPTS = [
    "Describe the current action on the field based on the player positions.",
    "What's happening in the play right now? Call it like you see it.",
    "Break down the formation and what the offense is trying to do.",
    "The ball is in play — give us the play-by-play!",
    "Read the field and tell us what's developing.",
]

# Emotion tag pattern for stripping from TTS text
_EMOTION_RE = re.compile(r"\[EMOTION:\w+\]\s*")

# Thread pool for blocking model inference
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="rfdetr")


class Debouncer:
    """Simple time-based debouncer."""

    def __init__(self, interval: float) -> None:
        self._interval = interval
        self._last_time = 0.0

    def __bool__(self) -> bool:
        now = time.monotonic()
        if (now - self._last_time) >= self._interval:
            self._last_time = now
            return True
        return False


class CommentaryPipeline:
    """End-to-end pipeline: reads video → detects objects → generates commentary → TTS → WebSocket.

    Runs entirely locally except for Claude API (LLM) and Cartesia API (TTS).
    No Stream SFU connection needed.

    Args:
        ws: WebSocket connection to stream results to the frontend.
        video_path: Path to the downloaded MP4 file.
    """

    def __init__(self, ws: WebSocket, video_path: Path) -> None:
        self.ws = ws
        self.video_path = video_path
        self._running = False

        # RF-DETR model (loaded during warmup)
        self._model: Any = None
        self._class_name_map: dict[int, str] = {}

        # Annotation helpers
        self._box_annotator = sv.BoxAnnotator(thickness=2)
        self._label_annotator = sv.LabelAnnotator(text_scale=0.5, text_thickness=1)

        # API clients
        self._anthropic = AsyncAnthropic(api_key=config.anthropic_api_key)
        self._cartesia = AsyncCartesia(api_key=config.cartesia_api_key)

        # Ball tracking state
        self._ball_was_present = False
        self._consecutive_no_ball = 0
        self._no_ball_threshold = 3

        # Debouncer
        self._debouncer = Debouncer(config.commentary_cooldown)

    async def run(self) -> None:
        """Main loop: warm up model, read frames, detect, commentate."""
        self._running = True

        try:
            # Load RF-DETR model (uses global cache)
            await self._send_status("Loading RF-DETR model...")
            cached = await get_or_load_model()
            self._model = cached["model"]
            self._class_name_map = cached["class_name_map"]
            await self._send_status("Model loaded. Starting commentary...")

            # Open video file
            track = await asyncio.to_thread(
                VideoFileTrack, str(self.video_path), fps=config.detection_fps
            )

            while self._running:
                try:
                    frame = await track.recv()
                except Exception:
                    logger.info("Video track ended or errored")
                    break

                # Check if client disconnected
                try:
                    # Non-blocking check for incoming messages (e.g. pause/stop)
                    msg = await asyncio.wait_for(self.ws.receive_json(), timeout=0.01)
                    if msg.get("type") == "stop":
                        logger.info("Client requested stop")
                        break
                except asyncio.TimeoutError:
                    pass
                except WebSocketDisconnect:
                    logger.info("WebSocket disconnected")
                    break

                # Run detection on the frame
                objects = await self._detect_frame(frame)

                # Ball tracking + commentary
                await self._handle_detections(objects)

        except WebSocketDisconnect:
            logger.info("WebSocket disconnected during pipeline")
        except asyncio.CancelledError:
            logger.info("Pipeline cancelled")
        except Exception:
            logger.exception("Pipeline error")
        finally:
            self._running = False
            await self._cartesia.close()
            logger.info("Pipeline stopped")

    async def stop(self) -> None:
        """Signal the pipeline to stop."""
        self._running = False

    # ---- Detection ----

    async def _detect_frame(self, frame: av.VideoFrame) -> list[DetectedObject]:
        """Run RF-DETR on a single frame, return detected objects."""
        if self._model is None:
            return []

        img = frame.to_ndarray(format="rgb24")
        loop = asyncio.get_running_loop()

        detections: sv.Detections = await loop.run_in_executor(
            _executor,
            lambda: self._model.predict(img, threshold=config.detection_confidence),
        )

        # Filter to person + sports ball
        detections = self._filter_detections(detections)
        return self._build_objects(detections)

    def _filter_detections(self, detections: sv.Detections) -> sv.Detections:
        """Keep only person and sports ball."""
        if detections.class_id is None:
            return detections

        allowed = {"person", "sports ball"}
        allowed_ids: set[int] = set()
        for cid, cname in self._class_name_map.items():
            if cname in allowed:
                allowed_ids.add(cid)

        mask = np.array([cid in allowed_ids for cid in detections.class_id])
        return detections[mask]

    def _build_objects(self, detections: sv.Detections) -> list[DetectedObject]:
        """Convert supervision Detections to DetectedObject list."""
        objects: list[DetectedObject] = []
        if detections.xyxy is None or len(detections.xyxy) == 0:
            return objects

        for i, bbox in enumerate(detections.xyxy):
            cid = int(detections.class_id[i]) if detections.class_id is not None else 0
            label = self._class_name_map.get(cid, f"class_{cid}")
            objects.append(
                DetectedObject(
                    label=label,
                    x1=int(bbox[0]),
                    y1=int(bbox[1]),
                    x2=int(bbox[2]),
                    y2=int(bbox[3]),
                )
            )
        return objects

    # ---- Ball tracking + commentary ----

    async def _handle_detections(self, objects: list[DetectedObject]) -> None:
        """Ball tracking logic + trigger commentary when appropriate."""
        ball_detected = any(obj["label"] == "sports ball" for obj in objects)

        # Ball reappearance after disappearing = play result
        if ball_detected and self._consecutive_no_ball >= self._no_ball_threshold:
            self._consecutive_no_ball = 0
            self._ball_was_present = True
            if self._debouncer:
                logger.info("Ball reappeared — triggering play result commentary")
                await self._commentate(
                    "The ball just reappeared after being out of frame! "
                    "Describe what likely happened — a completed pass, a big run, or a turnover."
                )
            return

        if ball_detected:
            self._consecutive_no_ball = 0
            self._ball_was_present = True
            if self._debouncer:
                await self._commentate(random.choice(COMMENTARY_PROMPTS))
        else:
            self._consecutive_no_ball += 1
            if (
                self._consecutive_no_ball >= self._no_ball_threshold
                and self._ball_was_present
                and self._debouncer
            ):
                logger.info("Ball disappeared for %d frames", self._consecutive_no_ball)
                await self._commentate(
                    "Big play! The ball just disappeared from the camera's view — "
                    "that means a long pass, a breakaway run, or something dramatic "
                    "is unfolding. Build the excitement!"
                )

    # ---- LLM + TTS ----

    async def _commentate(self, prompt: str) -> None:
        """Generate commentary via Claude, synthesize via Cartesia, send over WebSocket."""
        try:
            # Generate commentary text
            text = await self._generate_commentary(prompt)
            if not text:
                return

            # Strip emotion tag for display and TTS
            display_text = _EMOTION_RE.sub("", text).strip()

            # Extract emotion for Cartesia
            emotion_match = re.match(r"\[EMOTION:(\w+)\]", text)
            emotion = emotion_match.group(1) if emotion_match else "neutral"

            # Generate TTS audio
            audio_bytes = await self._synthesize_speech(display_text, emotion)

            # Send both text and audio to frontend
            await self.ws.send_json(
                {
                    "type": "commentary",
                    "text": display_text,
                    "emotion": emotion,
                    "audio": base64.b64encode(audio_bytes).decode() if audio_bytes else None,
                }
            )

            logger.info("Commentary sent: [%s] %s", emotion, display_text[:80])

        except WebSocketDisconnect:
            self._running = False
        except Exception:
            logger.exception("Error generating commentary")

    async def _generate_commentary(self, prompt: str) -> str:
        """Call Claude directly to generate commentary."""
        response = await self._anthropic.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=200,
            system=INSTRUCTIONS,
            messages=[{"role": "user", "content": prompt}],
        )
        if response.content and response.content[0].type == "text":
            return response.content[0].text
        return ""

    async def _synthesize_speech(self, text: str, emotion: str) -> bytes:
        """Generate TTS audio via Cartesia Sonic-3."""
        # Map emotion to speed adjustment
        speed_map = {
            "excited": 1.2,
            "tense": 1.1,
            "thoughtful": 0.9,
            "celebratory": 1.15,
            "disappointed": 0.85,
            "urgent": 1.2,
        }
        speed = speed_map.get(emotion, 1.0)

        audio_chunks: list[bytes] = []
        response = self._cartesia.tts.bytes(
            model_id="sonic-3",
            transcript=text,
            voice={"mode": "id", "id": config.voice_id_danny},
            output_format={
                "container": "mp3",
                "sample_rate": 44100,
                "bit_rate": 128000,
            },
            language="en",
            generation_config={"speed": speed},
        )
        async for chunk in response:
            audio_chunks.append(chunk)

        return b"".join(audio_chunks)

    # ---- Utility ----

    async def _send_status(self, message: str) -> None:
        """Send a status message to the frontend."""
        try:
            await self.ws.send_json({"type": "status", "message": message})
        except WebSocketDisconnect:
            self._running = False


# ---- Shared model cache ----
# Load the model once and reuse across pipeline instances
_cached_model: dict[str, Any] | None = None
_model_lock = asyncio.Lock()


async def get_or_load_model() -> dict[str, Any]:
    """Load the RF-DETR model once and cache it globally."""
    global _cached_model

    async with _model_lock:
        if _cached_model is not None:
            return _cached_model

        logger.info("Loading RF-DETR model (first request, will be cached)...")
        loop = asyncio.get_running_loop()

        def _load():
            model_id = config.rfdetr_model_id
            if model_id == "rfdetr-large":
                from rfdetr.detr import RFDETRLarge

                model = RFDETRLarge()
            else:
                from rfdetr.detr import RFDETRBase

                model = RFDETRBase()

            model.optimize_for_inference()
            return {"model": model, "class_name_map": dict(model.class_names)}

        _cached_model = await loop.run_in_executor(_executor, _load)
        logger.info("RF-DETR model cached globally")
        return _cached_model
