"""Event types for the local RF-DETR detection processor."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, TypedDict

import supervision as sv
from vision_agents.core.events.base import VideoProcessorDetectionEvent


class DetectedObject(TypedDict):
    """A single detected object from RF-DETR inference."""

    label: str
    x1: int
    y1: int
    x2: int
    y2: int


@dataclass
class DetectionCompletedEvent(VideoProcessorDetectionEvent):
    """Emitted when a frame has been processed by the local RF-DETR model.

    Contains the list of detected objects (filtered by class and confidence),
    the raw supervision Detections for advanced use, and the frame dimensions.
    """

    type: str = field(default="plugin.local_detection.detection_completed", init=False)
    objects: list[DetectedObject] = field(default_factory=list)
    raw_detections: Optional[sv.Detections] = field(default=None, repr=False)
    image_width: int = 0
    image_height: int = 0
