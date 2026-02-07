"""Custom processor for sports event detection using Roboflow object detection."""

from __future__ import annotations

import asyncio
import io
import logging
import time
import typing
from dataclasses import dataclass, field
from typing import Any, Optional

import aiohttp
import av
from vision_agents.core.processors.base_processor import VideoProcessor
from vision_agents.core.utils.video_forwarder import VideoForwarder

if typing.TYPE_CHECKING:
    from aiortc import VideoStreamTrack
    from vision_agents.core import Agent

logger = logging.getLogger(__name__)


@dataclass
class Detection:
    """A single object detection from Roboflow."""

    class_name: str
    confidence: float
    x: float
    y: float
    width: float
    height: float


@dataclass
class SportEvent:
    """A classified sports event derived from detections."""

    event_type: str
    description: str
    detections: list[Detection] = field(default_factory=list)
    timestamp: float = field(default_factory=time.time)


class SportsCommentaryProcessor(VideoProcessor):
    """Video processor that detects sports events via Roboflow and triggers LLM commentary.

    This processor receives video frames from the Vision Agents pipeline, sends them
    to the Roboflow REST API for object detection, classifies meaningful game events
    from detection patterns (e.g., ball disappearing suggests a big play), and triggers
    the agent's LLM to generate spoken commentary when events are detected.

    The key insight is that in broadcast football, the camera follows the ball. When
    the ball disappears from the frame for multiple consecutive frames, it strongly
    suggests a long pass, big run, or other significant play is happening. When the
    ball reappears, the play result is known.

    Args:
        roboflow_api_key: API key for Roboflow inference.
        model_id: Roboflow model identifier (e.g., "football-detection").
        detection_fps: How many frames per second to analyze. Default 5.
        confidence_threshold: Minimum confidence for a detection to count. Default 0.5.
        commentary_cooldown: Minimum seconds between commentary triggers. Default 3.0.
    """

    BALL_CLASSES: set[str] = {"football", "ball", "sports ball", "sports-ball"}
    PLAYER_CLASSES: set[str] = {"player", "person", "football-player", "football player"}
    NO_BALL_THRESHOLD: int = 3  # consecutive frames without ball before triggering
    CLUSTER_DISTANCE_THRESHOLD: float = 100.0  # pixels for player clustering
    CLUSTER_MIN_PLAYERS: int = 6  # minimum players in a cluster for goal-line event

    def __init__(
        self,
        roboflow_api_key: str,
        model_id: str = "football-detection",
        detection_fps: int = 5,
        confidence_threshold: float = 0.5,
        commentary_cooldown: float = 3.0,
    ) -> None:
        self._roboflow_api_key = roboflow_api_key
        self._model_id = model_id
        self._detection_fps = detection_fps
        self._confidence_threshold = confidence_threshold
        self._commentary_cooldown = commentary_cooldown

        # Agent reference (set via attach_agent)
        self._agent: Agent | None = None

        # Processing state
        self._running: bool = False
        self._session: aiohttp.ClientSession | None = None

        # Event detection state
        self._ball_was_present: bool = False
        self._consecutive_no_ball: int = 0
        self._big_play_triggered: bool = False
        self._last_commentary_time: float = 0.0

        # Frame handler reference for cleanup
        self._frame_handler_callback: Any = None
        self._shared_forwarder: VideoForwarder | None = None

    @property
    def name(self) -> str:
        return "sports_events"

    def attach_agent(self, agent: Agent) -> None:
        """Store the agent reference for triggering commentary via LLM."""
        self._agent = agent
        logger.info("SportsCommentaryProcessor attached to agent")

    async def process_video(
        self,
        track: VideoStreamTrack,
        participant_id: Optional[str],
        shared_forwarder: Optional[VideoForwarder] = None,
    ) -> None:
        """Start processing video frames for sports event detection.

        Uses the shared_forwarder's frame handler mechanism to receive frames at
        the configured FPS. Each frame is sent to Roboflow for detection and then
        classified for game events.

        Args:
            track: The incoming video stream track.
            participant_id: ID of the participant whose video this is.
            shared_forwarder: Shared VideoForwarder that manages frame distribution.
        """
        self._running = True
        self._session = aiohttp.ClientSession()

        logger.info(
            "Starting sports event detection (fps=%d, confidence=%.2f, cooldown=%.1fs)",
            self._detection_fps,
            self._confidence_threshold,
            self._commentary_cooldown,
        )

        if shared_forwarder is not None:
            self._shared_forwarder = shared_forwarder
            self._frame_handler_callback = self._on_frame
            shared_forwarder.add_frame_handler(
                self._on_frame,
                fps=self._detection_fps,
                name="sports_events",
            )
        else:
            # Fallback: read directly from the track in a loop
            logger.warning("No shared_forwarder provided, falling back to direct track reading")
            asyncio.create_task(self._read_track_loop(track))

    async def _read_track_loop(self, track: VideoStreamTrack) -> None:
        """Fallback loop for reading frames directly from a track without a forwarder."""
        from aiortc import MediaStreamError

        frame_interval = 1.0 / self._detection_fps
        try:
            while self._running:
                try:
                    frame = await asyncio.wait_for(track.recv(), timeout=5.0)
                    await self._on_frame(frame)
                    await asyncio.sleep(frame_interval)
                except asyncio.TimeoutError:
                    logger.debug("Timeout waiting for frame from track")
                    continue
                except MediaStreamError:
                    logger.info("Media stream ended, stopping direct track reader")
                    break
        except asyncio.CancelledError:
            logger.info("Direct track reader cancelled")
        except Exception:
            logger.exception("Error in direct track reader loop")

    async def _on_frame(self, frame: av.VideoFrame) -> None:
        """Process a single video frame: detect objects and classify events.

        This is the callback registered with the VideoForwarder. It converts the
        frame to JPEG, sends it to Roboflow, parses detections, and runs the
        event classification logic.

        Args:
            frame: The video frame to analyze.
        """
        if not self._running:
            return

        try:
            # Convert frame to JPEG bytes for the Roboflow API
            jpeg_bytes = self._frame_to_jpeg(frame)

            # Send to Roboflow for inference
            detections = await self._detect_objects(jpeg_bytes)

            if detections is None:
                # API error occurred, skip this frame
                return

            logger.debug(
                "Frame detections: %d objects (%s)",
                len(detections),
                ", ".join(f"{d.class_name}:{d.confidence:.2f}" for d in detections),
            )

            # Classify events from the detection pattern
            event = self._classify_event(detections)

            if event is not None:
                await self._handle_event(event)

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Error processing frame for sports events")

    def _frame_to_jpeg(self, frame: av.VideoFrame) -> bytes:
        """Convert an av.VideoFrame to JPEG bytes suitable for Roboflow API.

        Converts through PIL Image and compresses to JPEG at quality 80.
        The frame is resized to a max dimension of 640px to reduce upload time.

        Args:
            frame: The video frame to convert.

        Returns:
            JPEG-encoded bytes of the frame.
        """
        img = frame.to_image()

        # Resize to max 640px on the longest side to speed up inference
        max_dim = 640
        w, h = img.size
        if max(w, h) > max_dim:
            scale = max_dim / max(w, h)
            img = img.resize(
                (int(w * scale), int(h * scale)),
            )

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return buf.getvalue()

    async def _detect_objects(self, jpeg_bytes: bytes) -> list[Detection] | None:
        """Send a JPEG image to the Roboflow REST API for object detection.

        Args:
            jpeg_bytes: JPEG-encoded image bytes.

        Returns:
            List of Detection objects, or None if the API call failed.
        """
        if self._session is None or self._session.closed:
            logger.warning("HTTP session not available, skipping detection")
            return None

        url = (
            f"https://detect.roboflow.com/{self._model_id}"
            f"?api_key={self._roboflow_api_key}"
            f"&confidence={int(self._confidence_threshold * 100)}"
        )

        try:
            data = aiohttp.FormData()
            data.add_field(
                "file",
                jpeg_bytes,
                filename="frame.jpg",
                content_type="image/jpeg",
            )

            async with self._session.post(
                url, data=data, timeout=aiohttp.ClientTimeout(total=5.0)
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    logger.warning("Roboflow API returned status %d: %s", resp.status, body[:200])
                    return None

                result = await resp.json()
                return self._parse_detections(result)

        except asyncio.TimeoutError:
            logger.warning("Roboflow API request timed out")
            return None
        except aiohttp.ClientError as e:
            logger.warning("Roboflow API client error: %s", e)
            return None
        except Exception:
            logger.exception("Unexpected error calling Roboflow API")
            return None

    def _parse_detections(self, api_response: dict[str, Any]) -> list[Detection]:
        """Parse the Roboflow API response into Detection objects.

        The Roboflow hosted inference API returns predictions in the format:
        {
            "predictions": [
                {"class": "football", "confidence": 0.92, "x": 320, "y": 240, "width": 30, "height": 30},
                ...
            ]
        }

        Args:
            api_response: The parsed JSON response from Roboflow.

        Returns:
            List of Detection objects.
        """
        detections: list[Detection] = []
        predictions = api_response.get("predictions", [])

        for pred in predictions:
            det = Detection(
                class_name=pred.get("class", "unknown").lower(),
                confidence=pred.get("confidence", 0.0),
                x=pred.get("x", 0.0),
                y=pred.get("y", 0.0),
                width=pred.get("width", 0.0),
                height=pred.get("height", 0.0),
            )
            if det.confidence >= self._confidence_threshold:
                detections.append(det)

        return detections

    def _classify_event(self, detections: list[Detection]) -> SportEvent | None:
        """Classify a sports event from the current frame's detections.

        Implements the following event detection logic:

        1. **Ball tracking**: Tracks whether the ball (football) is visible.
           - Ball present -> reset no-ball counter, mark ball as seen.
           - Ball absent -> increment no-ball counter.
           - If ball absent for >= NO_BALL_THRESHOLD consecutive frames (0.6s at 5 FPS)
             and ball was previously present -> "big_play" event.
           - If ball reappears after being missing -> "play_result" event.

        2. **Player clustering**: If many players (>= CLUSTER_MIN_PLAYERS) are detected
           within a small area, it suggests a goal-line or short-yardage situation.

        Args:
            detections: List of detections from the current frame.

        Returns:
            A SportEvent if a meaningful event was detected, otherwise None.
        """
        ball_detections = [d for d in detections if d.class_name in self.BALL_CLASSES]
        player_detections = [d for d in detections if d.class_name in self.PLAYER_CLASSES]

        ball_present = len(ball_detections) > 0

        # Check for ball reappearance (play_result)
        if ball_present and self._big_play_triggered:
            missing_duration = self._consecutive_no_ball / max(self._detection_fps, 1)
            self._big_play_triggered = False
            self._consecutive_no_ball = 0
            self._ball_was_present = True
            logger.info(
                "Ball reappeared after big play (was missing for ~%.1fs)",
                missing_duration,
            )
            return SportEvent(
                event_type="play_result",
                description=(
                    "The ball has reappeared on screen after a big play! "
                    "The play seems to have concluded. Describe what likely "
                    "happened based on the players' positions and reactions."
                ),
                detections=detections,
            )

        if ball_present:
            # Ball is visible: reset tracking
            if not self._ball_was_present:
                logger.debug("Ball detected for the first time in this sequence")
            self._consecutive_no_ball = 0
            self._ball_was_present = True
        else:
            # Ball is NOT visible
            self._consecutive_no_ball += 1
            logger.debug("No ball detected (consecutive: %d)", self._consecutive_no_ball)

            # Trigger big_play if ball has been missing long enough
            if (
                self._consecutive_no_ball >= self.NO_BALL_THRESHOLD
                and self._ball_was_present
                and not self._big_play_triggered
            ):
                self._big_play_triggered = True
                missing_seconds = self._consecutive_no_ball / max(self._detection_fps, 1)
                logger.info(
                    "Big play detected! Ball missing for %d frames (~%.1fs)",
                    self._consecutive_no_ball,
                    missing_seconds,
                )
                return SportEvent(
                    event_type="big_play",
                    description=(
                        f"Big play detected! The ball disappeared from view for "
                        f"{missing_seconds:.1f} seconds, suggesting a long pass, "
                        f"big run, or significant play. The camera is following "
                        f"the action. Build excitement and speculate on what is "
                        f"happening!"
                    ),
                    detections=detections,
                )

        # Check for player clustering (goal-line / short-yardage)
        cluster_event = self._detect_player_cluster(player_detections)
        if cluster_event is not None:
            return cluster_event

        return None

    def _detect_player_cluster(self, player_detections: list[Detection]) -> SportEvent | None:
        """Detect if many players are clustered in a small area.

        This suggests a goal-line stand, short-yardage situation, or pile-up.
        Uses a simple approach: compute the bounding box of all player centers,
        and if enough players fit within a relatively small area, trigger the event.

        Args:
            player_detections: List of player detections from the current frame.

        Returns:
            A SportEvent if a cluster is detected, otherwise None.
        """
        if len(player_detections) < self.CLUSTER_MIN_PLAYERS:
            return None

        # Compute center positions
        centers = [(d.x, d.y) for d in player_detections]

        # Find the bounding box of all player centers
        xs = [c[0] for c in centers]
        ys = [c[1] for c in centers]
        x_range = max(xs) - min(xs)
        y_range = max(ys) - min(ys)

        # If all players are packed into a tight area relative to the number of players
        # (smaller spread per player = more clustered)
        avg_spread_per_player = (x_range + y_range) / (2 * len(player_detections))

        if avg_spread_per_player < self.CLUSTER_DISTANCE_THRESHOLD:
            logger.info(
                "Goal-line cluster detected: %d players, avg spread %.1f px/player",
                len(player_detections),
                avg_spread_per_player,
            )
            return SportEvent(
                event_type="goal_line",
                description=(
                    f"Goal-line or short-yardage situation detected! "
                    f"{len(player_detections)} players are clustered together "
                    f"in a tight formation. This could be a crucial play at the "
                    f"line of scrimmage. Describe the intensity of the moment!"
                ),
                detections=player_detections,
            )

        return None

    def _should_comment(self) -> bool:
        """Check if enough time has passed since the last commentary.

        Returns:
            True if the commentary cooldown has elapsed.
        """
        now = time.time()
        return (now - self._last_commentary_time) >= self._commentary_cooldown

    async def _handle_event(self, event: SportEvent) -> None:
        """Handle a detected sports event by triggering LLM commentary.

        Checks the commentary cooldown and, if sufficient time has passed,
        calls the agent's simple_response to generate and speak commentary.

        Args:
            event: The classified sports event to comment on.
        """
        if not self._should_comment():
            logger.debug(
                "Skipping %s event due to commentary cooldown (%.1fs remaining)",
                event.event_type,
                self._commentary_cooldown - (time.time() - self._last_commentary_time),
            )
            return

        if self._agent is None:
            logger.warning("Cannot trigger commentary: no agent attached to processor")
            return

        logger.info(
            "Triggering commentary for %s event: %s",
            event.event_type,
            event.description[:100],
        )

        self._last_commentary_time = time.time()

        try:
            await self._agent.simple_response(event.description)
        except Exception:
            logger.exception("Error triggering LLM commentary for %s event", event.event_type)

    async def stop_processing(self) -> None:
        """Stop processing video frames.

        Sets the running flag to False and removes the frame handler from
        the shared forwarder if one was used.
        """
        logger.info("Stopping sports event detection")
        self._running = False

        if self._shared_forwarder is not None and self._frame_handler_callback is not None:
            try:
                await self._shared_forwarder.remove_frame_handler(self._frame_handler_callback)
            except Exception:
                logger.exception("Error removing frame handler from forwarder")
            self._frame_handler_callback = None
            self._shared_forwarder = None

    async def close(self) -> None:
        """Close the processor and clean up all resources."""
        await self.stop_processing()

        if self._session is not None and not self._session.closed:
            await self._session.close()
            self._session = None

        # Reset detection state
        self._ball_was_present = False
        self._consecutive_no_ball = 0
        self._big_play_triggered = False
        self._last_commentary_time = 0.0

        logger.info("SportsCommentaryProcessor closed")
