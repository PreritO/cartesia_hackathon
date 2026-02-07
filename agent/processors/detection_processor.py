"""Local RF-DETR detection processor for the Vision Agents pipeline.

Runs RF-DETR inference locally (no API key, no network latency) and publishes
annotated frames back to the call. Emits DetectionCompletedEvent via the SDK's
EventManager so the agent can subscribe to detection results.

Modeled on the SDK's RoboflowLocalDetectionProcessor, but uses the `rfdetr`
package directly to avoid the `inference-sdk` dependency conflict.
"""

from __future__ import annotations

import asyncio
import logging
import time
import typing
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import av
import numpy as np
import supervision as sv
from vision_agents.core.processors import VideoProcessorPublisher
from vision_agents.core.utils.video_track import QueuedVideoTrack
from vision_agents.core.warmup import Warmable

from agent.processors.events import DetectedObject, DetectionCompletedEvent

if typing.TYPE_CHECKING:
    from aiortc import VideoStreamTrack
    from rfdetr.detr import RFDETRBase as RFDETRBaseType
    from vision_agents.core import Agent
    from vision_agents.core.utils.video_forwarder import VideoForwarder

logger = logging.getLogger(__name__)

# Thread pool for running blocking model inference off the event loop
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="rfdetr")


class LocalDetectionProcessor(VideoProcessorPublisher, Warmable[dict]):
    """Video processor that runs RF-DETR locally and publishes annotated frames.

    Extends VideoProcessorPublisher (process video + publish annotated output)
    and Warmable (cache the loaded model across agent restarts).

    Args:
        model_id: RF-DETR model variant. "rfdetr-base" or "rfdetr-large".
        conf_threshold: Minimum confidence for a detection to count.
        fps: How many frames per second to process.
        classes: COCO class names to keep (e.g. ["person", "sports ball"]).
            None means keep all classes.
        annotate: Whether to draw bounding boxes on published frames.
    """

    def __init__(
        self,
        model_id: str = "rfdetr-base",
        conf_threshold: float = 0.5,
        fps: int = 5,
        classes: list[str] | None = None,
        annotate: bool = True,
    ) -> None:
        self._model_id = model_id
        self._conf_threshold = conf_threshold
        self._fps = fps
        self._filter_classes = classes
        self._annotate = annotate

        # Set by on_warmed_up
        self._model: RFDETRBaseType | None = None
        self._class_name_map: dict[int, str] = {}

        # Set by attach_agent
        self._agent: Agent | None = None

        # Output track for annotated frames
        self._output_track = QueuedVideoTrack(width=1280, height=720, fps=fps)

        # Annotation helpers
        self._box_annotator = sv.BoxAnnotator(thickness=2)
        self._label_annotator = sv.LabelAnnotator(text_scale=0.5, text_thickness=1)

        # Processing state
        self._running = False
        self._shared_forwarder: VideoForwarder | None = None
        self._frame_handler_ref = None

    # ---- Processor identity ----

    @property
    def name(self) -> str:
        return "local_detection"

    # ---- Warmable: load model once, cache across agent restarts ----

    async def on_warmup(self) -> dict:
        """Load the RF-DETR model. Called once at startup; result is cached."""
        logger.info("Loading RF-DETR model: %s", self._model_id)

        loop = asyncio.get_running_loop()

        def _load() -> dict:
            if self._model_id == "rfdetr-large":
                from rfdetr.detr import RFDETRLarge

                model = RFDETRLarge()
            else:
                from rfdetr.detr import RFDETRBase

                model = RFDETRBase()

            model.optimize_for_inference()
            class_name_map = dict(model.class_names)
            logger.info("RF-DETR model loaded (%d classes, optimized)", len(class_name_map))
            return {"model": model, "class_name_map": class_name_map}

        return await loop.run_in_executor(_executor, _load)

    def on_warmed_up(self, resource: dict) -> None:
        """Store the cached model reference."""
        self._model = resource["model"]
        self._class_name_map = resource["class_name_map"]
        logger.info("RF-DETR model ready")

    # ---- Agent integration ----

    def attach_agent(self, agent: Agent) -> None:
        """Register our custom event type with the agent's EventManager."""
        self._agent = agent
        agent.event_manager.register(DetectionCompletedEvent)
        logger.info("LocalDetectionProcessor attached to agent, event registered")

    # ---- VideoPublisher: output annotated frames ----

    def publish_video_track(self) -> QueuedVideoTrack:
        """Return the output track that carries annotated frames."""
        return self._output_track

    # ---- VideoProcessor: receive input frames ----

    async def process_video(
        self,
        track: VideoStreamTrack,
        participant_id: Optional[str],
        shared_forwarder: Optional[VideoForwarder] = None,
    ) -> None:
        """Start processing video frames for detection."""
        self._running = True

        logger.info(
            "Starting local detection (model=%s, fps=%d, conf=%.2f, annotate=%s)",
            self._model_id,
            self._fps,
            self._conf_threshold,
            self._annotate,
        )

        if shared_forwarder is not None:
            self._shared_forwarder = shared_forwarder
            self._frame_handler_ref = self._on_frame
            shared_forwarder.add_frame_handler(
                self._on_frame,
                fps=self._fps,
                name="local_detection",
            )
        else:
            logger.warning("No shared_forwarder; falling back to direct track reading")
            asyncio.create_task(self._read_track_loop(track))

    async def _read_track_loop(self, track: VideoStreamTrack) -> None:
        """Fallback: read frames directly from track when no forwarder."""
        from aiortc import MediaStreamError

        interval = 1.0 / self._fps
        try:
            while self._running:
                try:
                    frame = await asyncio.wait_for(track.recv(), timeout=5.0)
                    await self._on_frame(frame)
                    await asyncio.sleep(interval)
                except asyncio.TimeoutError:
                    continue
                except MediaStreamError:
                    logger.info("Media stream ended")
                    break
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Error in direct track reader")

    # ---- Frame processing core ----

    async def _on_frame(self, frame: av.VideoFrame) -> None:
        """Process a single video frame: detect, annotate, emit event."""
        if not self._running or self._model is None:
            return

        try:
            img = frame.to_ndarray(format="rgb24")
            h, w = img.shape[:2]

            # Run inference in thread pool to avoid blocking the event loop
            loop = asyncio.get_running_loop()
            t0 = time.perf_counter()
            detections = await loop.run_in_executor(
                _executor,
                lambda: self._model.predict(img, threshold=self._conf_threshold),
            )
            inference_ms = (time.perf_counter() - t0) * 1000

            # Filter by class if configured
            detections = self._filter_detections(detections)

            # Build the list of DetectedObject dicts
            objects = self._build_objects(detections)

            # Annotate and publish frame
            if self._annotate:
                annotated = self._annotate_frame(img, detections)
                out_frame = av.VideoFrame.from_ndarray(annotated, format="rgb24")
            else:
                out_frame = frame

            await self._output_track.add_frame(out_frame)

            # Emit detection event
            if self._agent is not None:
                event = DetectionCompletedEvent(
                    plugin_name="local_detection",
                    model_id=self._model_id,
                    inference_time_ms=inference_ms,
                    detection_count=len(objects),
                    objects=objects,
                    raw_detections=detections,
                    image_width=w,
                    image_height=h,
                )
                self._agent.event_manager.send(event)

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Error processing frame for detection")

    def _filter_detections(self, detections: sv.Detections) -> sv.Detections:
        """Filter detections to only include configured classes."""
        if self._filter_classes is None or detections.class_id is None:
            return detections

        # Build set of allowed class IDs
        allowed_ids: set[int] = set()
        for cid, cname in self._class_name_map.items():
            if cname in self._filter_classes:
                allowed_ids.add(cid)

        mask = np.array([cid in allowed_ids for cid in detections.class_id])
        return detections[mask]

    def _build_objects(self, detections: sv.Detections) -> list[DetectedObject]:
        """Convert supervision Detections to our DetectedObject list."""
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

    def _annotate_frame(self, img: np.ndarray, detections: sv.Detections) -> np.ndarray:
        """Draw bounding boxes and labels on the frame."""
        labels = []
        for i in range(len(detections.xyxy)):
            cid = int(detections.class_id[i]) if detections.class_id is not None else 0
            label = self._class_name_map.get(cid, f"class_{cid}")
            conf = float(detections.confidence[i]) if detections.confidence is not None else 0.0
            labels.append(f"{label} {conf:.2f}")

        annotated = self._box_annotator.annotate(scene=img.copy(), detections=detections)
        annotated = self._label_annotator.annotate(
            scene=annotated, detections=detections, labels=labels
        )
        return annotated

    # ---- Lifecycle ----

    async def stop_processing(self) -> None:
        """Stop processing video frames."""
        logger.info("Stopping local detection processor")
        self._running = False

        if self._shared_forwarder is not None and self._frame_handler_ref is not None:
            try:
                await self._shared_forwarder.remove_frame_handler(self._frame_handler_ref)
            except Exception:
                logger.exception("Error removing frame handler")
            self._frame_handler_ref = None
            self._shared_forwarder = None

        self._output_track.stop()

    async def close(self) -> None:
        """Close the processor and clean up resources."""
        await self.stop_processing()
        self._model = None
        self._class_name_map = {}
        logger.info("LocalDetectionProcessor closed")
