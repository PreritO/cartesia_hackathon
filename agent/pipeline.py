"""Commentary pipelines: video/live → detection → LLM → TTS → WebSocket.

Provides a ``BaseCommentaryPipeline`` with all shared detection, LLM, and TTS
logic, plus two concrete subclasses:

* ``CommentaryPipeline`` -- reads an MP4 file via VideoFileTrack.
* ``LiveCommentaryPipeline`` -- accepts live JPEG frames pushed externally.
"""

from __future__ import annotations

import asyncio
import base64
import io
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
from PIL import Image
from vision_agents.core.utils.video_track import VideoFileTrack

from agent.config import config
from agent.processors.events import DetectedObject
from agent.user_profile import UserProfile

logger = logging.getLogger(__name__)

# ---- Sport-specific instruction loading ----

_INSTRUCTIONS_DIR = Path(__file__).parent / "instructions"

# Soccer (default)
INSTRUCTIONS_BASE_SOCCER = (_INSTRUCTIONS_DIR / "commentary.md").read_text()
INSTRUCTIONS_DANNY_SOCCER = (_INSTRUCTIONS_DIR / "danny.md").read_text()
INSTRUCTIONS_COACH_KAY_SOCCER = (_INSTRUCTIONS_DIR / "coach_kay.md").read_text()
INSTRUCTIONS_ROOKIE_SOCCER = (_INSTRUCTIONS_DIR / "rookie.md").read_text()

# American Football
INSTRUCTIONS_BASE_FOOTBALL = (_INSTRUCTIONS_DIR / "commentary_football.md").read_text()
INSTRUCTIONS_DANNY_FOOTBALL = (_INSTRUCTIONS_DIR / "danny_football.md").read_text()
INSTRUCTIONS_COACH_KAY_FOOTBALL = (_INSTRUCTIONS_DIR / "coach_kay_football.md").read_text()
INSTRUCTIONS_ROOKIE_FOOTBALL = (_INSTRUCTIONS_DIR / "rookie_football.md").read_text()

# Supported sports
SUPPORTED_SPORTS = {"soccer", "football"}

_INSTRUCTIONS_BY_SPORT: dict[str, dict[str, str]] = {
    "soccer": {
        "base": INSTRUCTIONS_BASE_SOCCER,
        "danny": INSTRUCTIONS_DANNY_SOCCER,
        "coach_kay": INSTRUCTIONS_COACH_KAY_SOCCER,
        "rookie": INSTRUCTIONS_ROOKIE_SOCCER,
    },
    "football": {
        "base": INSTRUCTIONS_BASE_FOOTBALL,
        "danny": INSTRUCTIONS_DANNY_FOOTBALL,
        "coach_kay": INSTRUCTIONS_COACH_KAY_FOOTBALL,
        "rookie": INSTRUCTIONS_ROOKIE_FOOTBALL,
    },
}

COMMENTARY_PROMPTS_SOCCER = {
    "danny": [
        "Call the action you see right now -- what's happening on the pitch?",
        "Describe this moment like you're painting a picture for the listener.",
        "What's developing on the field? Give us the play-by-play.",
    ],
    "coach_kay": [
        "Break down what you see tactically -- formations, shape, strategy.",
        "What's the tactical story here? Why are the teams set up this way?",
        "Analyze what just happened or what's developing from a coaching perspective.",
    ],
    "rookie": [
        "React to what's happening like you're watching with a friend. Use any viewer context you have.",
        "What would you say to the viewer right now? Make it personal and fun.",
        "Chat about what you see -- bring in any personal connections to the viewer.",
    ],
}

COMMENTARY_PROMPTS_FOOTBALL = {
    "danny": [
        "Call the play you see -- formation, snap, what's happening on the field right now.",
        "Describe this play like you're painting the picture for the audience at home.",
        "What just happened? Give us the play-by-play -- yards, tackle, result.",
    ],
    "coach_kay": [
        "Break down what you see -- offensive formation, defensive alignment, coverage shell.",
        "What's the tactical story here? Why did they call this play in this situation?",
        "Analyze what just happened from a coaching perspective -- scheme, execution, adjustments.",
    ],
    "rookie": [
        "React to what's happening like you're watching with a friend. Use any viewer context you have.",
        "What would you say to the viewer right now? Make it personal and fun.",
        "Chat about what you see -- bring in any personal connections to the viewer.",
    ],
}

COMMENTARY_PROMPTS_BY_SPORT: dict[str, dict[str, list[str]]] = {
    "soccer": COMMENTARY_PROMPTS_SOCCER,
    "football": COMMENTARY_PROMPTS_FOOTBALL,
}


def _build_analysts(sport: str) -> dict[str, dict]:
    """Build analyst definitions for a given sport."""
    instructions = _INSTRUCTIONS_BY_SPORT.get(sport, _INSTRUCTIONS_BY_SPORT["soccer"])
    return {
        "danny": {
            "label": "Danny",
            "prompt": instructions["danny"],
            "voice_key": "danny",
            "scenes": {"active_play", "play_without_ball", "transition"},
        },
        "coach_kay": {
            "label": "Coach Kay",
            "prompt": instructions["coach_kay"],
            "voice_key": "coach_kay",
            "scenes": {"close_up", "no_players"},
        },
        "rookie": {
            "label": "Rookie",
            "prompt": instructions["rookie"],
            "voice_key": "rookie",
            "scenes": set(),
        },
    }


# Default analysts (soccer) for backwards compatibility
ANALYSTS = _build_analysts("soccer")

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


class BaseCommentaryPipeline:
    """Shared detection, LLM commentary, and TTS logic.

    Subclasses provide the frame source (file or live).  This base class owns
    the RF-DETR model reference, API clients, ball-tracking state, debouncing,
    and all commentary generation / TTS synthesis methods.

    Args:
        ws: WebSocket connection to stream results to the frontend.
    """

    def __init__(
        self, ws: WebSocket, profile: UserProfile | None = None, sport: str = "soccer"
    ) -> None:
        self.ws = ws
        self._running = False

        # Sport type (soccer or football)
        self._sport: str = sport if sport in SUPPORTED_SPORTS else "soccer"
        self._analysts = _build_analysts(self._sport)
        self._commentary_prompts = COMMENTARY_PROMPTS_BY_SPORT.get(
            self._sport, COMMENTARY_PROMPTS_SOCCER
        )
        self._instructions = _INSTRUCTIONS_BY_SPORT.get(
            self._sport, _INSTRUCTIONS_BY_SPORT["soccer"]
        )

        # User profile for personalized commentary
        self._profile: UserProfile = profile or UserProfile()

        # RF-DETR model (loaded via _load_model)
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
        self._last_ball_pos: tuple[float, float] | None = None  # (cx, cy) normalized 0-1
        self._ball_trajectory: list[tuple[float, float]] = []  # recent positions

        # Frame dimensions (set on first detection)
        self._frame_w = 0
        self._frame_h = 0

        # Last annotated frame (base64 JPEG, sent with commentary)
        self._last_annotated_frame: str | None = None

        # Current frame as base64 JPEG for sending to Claude (multimodal)
        self._current_frame_b64: str | None = None

        # Debouncer
        self._debouncer = Debouncer(config.commentary_cooldown)

        # Frame capture timestamp from the frontend (for sync with delayed playback)
        self._last_frame_ts: float = 0.0

        # Frame counter for debug logging
        self._frame_count = 0

        # Recent commentary history (passed to Claude to avoid repetition)
        self._recent_commentary: list[str] = []

        # Multi-analyst rotation state
        self._commentary_count = 0
        self._last_analyst: str = "danny"
        self._last_scene: str = "transition"

    def set_profile(self, profile: UserProfile) -> None:
        """Update the user profile (can be called mid-session)."""
        self._profile = profile
        logger.info(
            "Profile set: %s (expertise=%d, hot_take=%d)",
            profile.name,
            profile.expertise_slider,
            profile.hot_take_slider,
        )

    def set_sport(self, sport: str) -> None:
        """Switch sport mid-session (reconfigures instructions and prompts)."""
        if sport not in SUPPORTED_SPORTS:
            logger.warning("Unsupported sport: %s (keeping %s)", sport, self._sport)
            return
        self._sport = sport
        self._analysts = _build_analysts(sport)
        self._commentary_prompts = COMMENTARY_PROMPTS_BY_SPORT.get(sport, COMMENTARY_PROMPTS_SOCCER)
        self._instructions = _INSTRUCTIONS_BY_SPORT.get(sport, _INSTRUCTIONS_BY_SPORT["soccer"])
        logger.info("Sport switched to: %s", sport)

    def _pick_analyst(self, scene: str) -> str:
        """Pick which analyst speaks based on scene type and rotation.

        Strategy:
        - Danny (play-by-play): most action scenes — ~55% of commentary
        - Coach Kay (tactical): lulls, close-ups, replays — ~30%
        - Rookie (personal): every 4th commentary when viewer has profile — ~15%
        """
        self._commentary_count += 1

        # Rookie gets every 4th turn IF the viewer has personal context
        has_personal = bool(
            self._profile.favorite_team
            or self._profile.favorite_players
            or self._profile.alma_mater
        )
        if has_personal and self._commentary_count % 4 == 0:
            return "rookie"

        # Otherwise pick by scene affinity
        for key, analyst in self._analysts.items():
            if scene in analyst["scenes"]:
                # Don't let the same analyst go 3x in a row (except Danny during action)
                if key == self._last_analyst and key != "danny":
                    return "danny"
                return key

        # Default to Danny
        return "danny"

    def _build_system_prompt(self, analyst_key: str = "danny") -> str:
        """Build the full system prompt = base + analyst personality + personalization."""
        analyst = self._analysts.get(analyst_key, self._analysts["danny"])
        prompt = self._instructions["base"] + "\n\n" + analyst["prompt"]
        profile_block = self._profile.build_prompt_block(sport=self._sport)
        if profile_block:
            prompt += "\n" + profile_block
        return prompt

    # ---- Model loading ----

    async def _load_model(self) -> None:
        """Load (or retrieve from cache) the RF-DETR model."""
        await self._send_status("Loading RF-DETR model...")
        cached = await get_or_load_model()
        self._model = cached["model"]
        self._class_name_map = cached["class_name_map"]
        await self._send_status("Model loaded. Starting commentary...")

    # ---- Detection ----

    async def _detect_from_array(self, img: np.ndarray) -> list[DetectedObject]:
        """Run RF-DETR on an RGB24 numpy array, return detected objects."""
        if self._model is None:
            return []

        self._frame_count += 1
        self._frame_h, self._frame_w = img.shape[:2]
        loop = asyncio.get_running_loop()

        raw_detections: sv.Detections = await loop.run_in_executor(
            _executor,
            lambda: self._model.predict(img, threshold=config.detection_confidence),
        )

        # Annotate frame with all detections (before filtering)
        self._annotate_frame(img, raw_detections)

        # Store current annotated frame as base64 for Claude vision
        self._current_frame_b64 = self._last_annotated_frame

        # Filter to person + sports ball
        detections = self._filter_detections(raw_detections)
        objects = self._build_objects(detections)

        # Debug logging every 25 frames (~5s at 5 FPS)
        if self._frame_count % 25 == 0:
            person_count = sum(1 for o in objects if o["label"] == "person")
            ball_count = sum(1 for o in objects if o["label"] == "sports ball")
            total_raw = len(raw_detections) if raw_detections else 0
            logger.info(
                "Frame %d: %d raw detections → %d persons, %d balls",
                self._frame_count,
                total_raw,
                person_count,
                ball_count,
            )

        # Send annotated frame to frontend every 10 frames (~2s) for debug overlay
        if self._frame_count % 10 == 0 and self._last_annotated_frame:
            try:
                await self.ws.send_json(
                    {
                        "type": "detection",
                        "annotated_frame": self._last_annotated_frame,
                        "person_count": sum(1 for o in objects if o["label"] == "person"),
                        "ball_count": sum(1 for o in objects if o["label"] == "sports ball"),
                    }
                )
            except WebSocketDisconnect:
                self._running = False

        return objects

    def _annotate_frame(self, img: np.ndarray, detections: sv.Detections) -> None:
        """Draw bounding boxes on a copy of the frame and store as base64 JPEG."""
        try:
            annotated = img.copy()
            labels = []
            if detections.class_id is not None:
                for cid in detections.class_id:
                    labels.append(self._class_name_map.get(int(cid), f"class_{cid}"))

            annotated = self._box_annotator.annotate(annotated, detections)
            if labels:
                annotated = self._label_annotator.annotate(annotated, detections, labels=labels)

            pil_img = Image.fromarray(annotated)
            buf = io.BytesIO()
            pil_img.save(buf, format="JPEG", quality=50)
            self._last_annotated_frame = base64.b64encode(buf.getvalue()).decode()
        except Exception:
            logger.exception("Error annotating frame")

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

    def _zone_label(self, cx: float, cy: float) -> str:
        """Map normalized (0-1) center coords to a field zone label."""
        # Horizontal: left third / center / right third
        if cx < 0.33:
            h = "left"
        elif cx > 0.67:
            h = "right"
        else:
            h = "center"

        if self._sport == "football":
            # American football: end zone / red zone / midfield / own territory
            if cy < 0.15 or cy > 0.85:
                v = "end zone"
            elif cy < 0.30 or cy > 0.70:
                v = "red zone"
            elif 0.40 < cy < 0.60:
                v = "midfield"
            else:
                v = "between the 30s"
        else:
            # Soccer: far side / midfield / near side
            if cy < 0.33:
                v = "far side"
            elif cy > 0.67:
                v = "near side"
            else:
                v = "midfield"

        return f"{h} {v}"

    def _classify_scene(self, objects: list[DetectedObject]) -> str:
        """Simple heuristic to classify the current scene type."""
        person_count = sum(1 for o in objects if o["label"] == "person")
        ball_count = sum(1 for o in objects if o["label"] == "sports ball")
        if person_count >= 6 and ball_count >= 1:
            return "active_play"
        if person_count >= 6 and ball_count == 0:
            return "play_without_ball"
        if 1 <= person_count <= 3:
            return "close_up"
        if person_count == 0:
            return "no_players"
        return "transition"

    def _ball_movement_description(self) -> str:
        """Describe ball movement from recent trajectory."""
        traj = self._ball_trajectory
        if len(traj) < 2:
            return ""
        prev = traj[-2]
        curr = traj[-1]
        dx = curr[0] - prev[0]
        dy = curr[1] - prev[1]
        dist = (dx**2 + dy**2) ** 0.5

        if dist < 0.02:
            return "Ball is nearly stationary."
        parts = []
        if abs(dx) > 0.02:
            parts.append("right" if dx > 0 else "left")
        if abs(dy) > 0.02:
            parts.append("downfield" if dy > 0 else "upfield")
        direction = " and ".join(parts) if parts else "moving"
        speed = "rapidly" if dist > 0.1 else "steadily"
        return f"Ball moving {speed} {direction}."

    def _build_detection_context(self, objects: list[DetectedObject]) -> str:
        """Build a rich text summary of detections for the LLM prompt."""
        person_count = sum(1 for o in objects if o["label"] == "person")
        ball_objs = [o for o in objects if o["label"] == "sports ball"]
        ball_count = len(ball_objs)

        # Scene type
        scene = self._classify_scene(objects)
        scene_labels = {
            "active_play": "Active play",
            "play_without_ball": "Players on field, ball not visible",
            "close_up": "Close-up shot",
            "no_players": "No players visible (crowd/replay/graphic)",
            "transition": "Transitional shot",
        }
        parts = [f"Scene: {scene_labels.get(scene, scene)}."]
        parts.append(f"{person_count} players detected.")

        # Ball position and zone
        if ball_count and self._frame_w > 0:
            ball = ball_objs[0]
            cx = ((ball["x1"] + ball["x2"]) / 2) / self._frame_w
            cy = ((ball["y1"] + ball["y2"]) / 2) / self._frame_h
            zone = self._zone_label(cx, cy)
            parts.append(f"Ball in the {zone} area.")

            # Track trajectory
            self._ball_trajectory.append((cx, cy))
            if len(self._ball_trajectory) > 5:
                self._ball_trajectory.pop(0)
            self._last_ball_pos = (cx, cy)

            # Movement description
            movement = self._ball_movement_description()
            if movement:
                parts.append(movement)
        else:
            parts.append("Ball not visible.")
            # Don't clear trajectory — we'll use it when ball reappears

        # Player clustering (rough)
        if person_count >= 4 and self._frame_w > 0:
            persons = [o for o in objects if o["label"] == "person"]
            xs = [((o["x1"] + o["x2"]) / 2) / self._frame_w for o in persons]
            # Check if players are clustered (std dev < 0.15 = tight group)
            mean_x = sum(xs) / len(xs)
            spread = (sum((x - mean_x) ** 2 for x in xs) / len(xs)) ** 0.5
            if spread < 0.15:
                cluster_zone = self._zone_label(mean_x, 0.5)
                if self._sport == "football":
                    parts.append(
                        f"Players clustered in the {cluster_zone} — possible huddle, goal-line, or short-yardage situation."
                    )
                else:
                    parts.append(
                        f"Players clustered in the {cluster_zone} — possible set piece or buildup."
                    )

        return " ".join(parts)

    async def _handle_detections(self, objects: list[DetectedObject]) -> None:
        """Timer-based commentary: every debounce interval, send frame + context to Claude.

        RF-DETR enriches the prompt but does NOT gate whether commentary happens.
        Claude sees the frame and decides what's worth saying.
        """
        # Update ball tracking state (for trajectory enrichment only)
        ball_detected = any(obj["label"] == "sports ball" for obj in objects)
        if ball_detected:
            self._consecutive_no_ball = 0
            self._ball_was_present = True
        else:
            self._consecutive_no_ball += 1

        # Build detection context (always, for enrichment)
        det_context = self._build_detection_context(objects)

        # Track current scene for analyst selection
        self._last_scene = self._classify_scene(objects)

        # Timer-based: when debouncer allows, commentate regardless of detection
        if self._debouncer:
            # Snapshot frame_ts NOW before async Claude call
            snapshot_ts = self._last_frame_ts
            # Pick analyst based on scene and rotation
            analyst_key = self._pick_analyst(self._last_scene)
            self._last_analyst = analyst_key

            prompts = self._commentary_prompts.get(analyst_key, self._commentary_prompts["danny"])
            prompt = random.choice(prompts)
            await self._commentate(
                f"{det_context} {prompt}", analyst_key=analyst_key, frame_ts=snapshot_ts
            )

    # ---- LLM + TTS ----

    async def _commentate(
        self, prompt: str, analyst_key: str = "danny", frame_ts: float | None = None
    ) -> None:
        """Generate commentary via Claude, synthesize via Cartesia, send over WebSocket."""
        analyst = self._analysts.get(analyst_key, self._analysts["danny"])
        # Snapshot frame_ts NOW (before async calls overwrite _last_frame_ts)
        captured_frame_ts = frame_ts if frame_ts is not None else self._last_frame_ts

        try:
            # Build prompt with recent history so Claude doesn't repeat itself
            full_prompt = prompt
            if self._recent_commentary:
                history = "\n".join(f"- {line}" for line in self._recent_commentary[-3:])
                full_prompt = (
                    f"{prompt}\n\n"
                    f"Recent commentary from the broadcast booth (DO NOT repeat):\n{history}\n"
                    f"Build on what your colleagues said or move the commentary forward. "
                    f"If nothing new to add, respond with SKIP."
                )

            # Generate commentary text with this analyst's persona
            text = await self._generate_commentary(full_prompt, analyst_key=analyst_key)
            if not text:
                return

            # Strip emotion tag for display and TTS
            display_text = _EMOTION_RE.sub("", text).strip()

            # Track recent commentary
            self._recent_commentary.append(f"[{analyst['label']}] {display_text}")
            if len(self._recent_commentary) > 5:
                self._recent_commentary.pop(0)

            # Extract emotion for Cartesia
            emotion_match = re.match(r"\[EMOTION:(\w+)\]", text)
            emotion = emotion_match.group(1) if emotion_match else "neutral"

            # Generate TTS audio with this analyst's voice
            voice_id = self._get_voice_id_for_analyst(analyst_key)
            audio_bytes = await self._synthesize_speech(display_text, emotion, voice_id=voice_id)

            # Send text, audio, and analyst info to frontend
            await self.ws.send_json(
                {
                    "type": "commentary",
                    "text": display_text,
                    "emotion": emotion,
                    "analyst": analyst["label"],
                    "audio": base64.b64encode(audio_bytes).decode() if audio_bytes else None,
                    "annotated_frame": self._last_annotated_frame,
                    "frame_ts": captured_frame_ts,
                }
            )

            logger.info(
                "[%s] Commentary sent: [%s] %s",
                analyst["label"],
                emotion,
                display_text[:80],
            )

        except WebSocketDisconnect:
            self._running = False
        except Exception:
            logger.exception("Error generating commentary")

    async def _generate_commentary(self, prompt: str, analyst_key: str = "danny") -> str:
        """Call Claude with the annotated frame (multimodal) + text prompt."""
        content: list[dict[str, Any]] = []

        if self._current_frame_b64:
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": self._current_frame_b64,
                    },
                }
            )

        content.append({"type": "text", "text": prompt})

        response = await self._anthropic.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=160,
            system=self._build_system_prompt(analyst_key=analyst_key),
            messages=[{"role": "user", "content": content}],
        )
        if response.content and response.content[0].type == "text":
            text = response.content[0].text.strip()
            # If LLM says SKIP, nothing worth commenting on
            if text.upper() == "SKIP" or (
                text.upper().startswith("[EMOTION") and "SKIP" in text.upper()
            ):
                return ""
            return text
        return ""

    def _get_voice_id_for_analyst(self, analyst_key: str) -> str:
        """Get Cartesia voice ID for a specific analyst."""
        voice_map = {
            "danny": config.voice_id_danny,
            "coach_kay": config.voice_id_coach_kay,
            "rookie": config.voice_id_rookie,
        }
        voice_id = voice_map.get(analyst_key, config.voice_id_danny)
        return voice_id or config.voice_id_danny

    async def _synthesize_speech(
        self, text: str, emotion: str, voice_id: str | None = None
    ) -> bytes:
        """Generate TTS audio via Cartesia Sonic-3."""
        # Map emotion to speed adjustment
        speed_map = {
            "excited": 1.2,
            "tense": 1.1,
            "thoughtful": 1.1,
            "celebratory": 1.3,
            "disappointed": 1.0,
            "urgent": 1.2,
        }
        speed = speed_map.get(emotion, 1.3)

        if not voice_id:
            voice_id = self._get_voice_id_for_analyst("danny")
        audio_chunks: list[bytes] = []
        response = self._cartesia.tts.bytes(
            model_id="sonic-3",
            transcript=text,
            voice={"mode": "id", "id": voice_id},
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

    async def stop(self) -> None:
        """Signal the pipeline to stop and clean up resources."""
        self._running = False
        await self._cartesia.close()


class CommentaryPipeline(BaseCommentaryPipeline):
    """File-based pipeline: reads an MP4 via VideoFileTrack and runs commentary.

    Args:
        ws: WebSocket connection to stream results to the frontend.
        video_path: Path to the downloaded MP4 file.
    """

    def __init__(self, ws: WebSocket, video_path: Path) -> None:
        super().__init__(ws)
        self.video_path = video_path

    async def run(self) -> None:
        """Main loop: warm up model, read frames, detect, commentate."""
        self._running = True

        try:
            await self._load_model()

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
                objects = await self._detect_from_array(frame.to_ndarray(format="rgb24"))

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


class LiveCommentaryPipeline(BaseCommentaryPipeline):
    """Live pipeline: accepts externally-pushed JPEG frames.

    Unlike ``CommentaryPipeline`` which reads from a file, this class exposes
    an ``initialize`` / ``process_frame`` interface so a caller (e.g. a
    WebSocket handler receiving webcam frames) can feed frames one at a time.

    Args:
        ws: WebSocket connection to stream results to the frontend.
        profile: Optional user profile for personalized commentary.
    """

    def __init__(
        self,
        ws: WebSocket,
        profile: UserProfile | None = None,
        skip_detection: bool = True,
        sport: str = "soccer",
    ) -> None:
        super().__init__(ws, profile=profile, sport=sport)
        self._skip_detection = skip_detection

    async def initialize(self) -> None:
        """Load model (if detection enabled) and notify the client."""
        self._running = True
        if self._skip_detection:
            await self._send_status("Ready — sending frames directly to Claude.")
        else:
            await self._load_model()

    async def process_frame(self, jpeg_bytes: bytes) -> None:
        """Process a JPEG frame: either via RF-DETR or straight to Claude.

        Args:
            jpeg_bytes: Raw JPEG image bytes (e.g. from a webcam capture).
        """
        if not self._running:
            return

        if self._skip_detection:
            # Fast path: skip RF-DETR, just store the frame for Claude and commentate
            self._frame_count += 1
            self._current_frame_b64 = base64.b64encode(jpeg_bytes).decode()

            if self._debouncer:
                # Snapshot frame_ts NOW before async Claude call
                snapshot_ts = self._last_frame_ts
                analyst_key = self._pick_analyst("active_play")
                self._last_analyst = analyst_key
                prompts = self._commentary_prompts.get(
                    analyst_key, self._commentary_prompts["danny"]
                )
                prompt = random.choice(prompts)
                sport_label = (
                    "American football game" if self._sport == "football" else "soccer match"
                )
                await self._commentate(
                    f"Describe what you see in this {sport_label} frame. {prompt}",
                    analyst_key=analyst_key,
                    frame_ts=snapshot_ts,
                )
        else:
            # Full path: RF-DETR detection → enriched commentary
            img = Image.open(io.BytesIO(jpeg_bytes)).convert("RGB")
            frame_array = np.array(img)
            objects = await self._detect_from_array(frame_array)
            await self._handle_detections(objects)


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
