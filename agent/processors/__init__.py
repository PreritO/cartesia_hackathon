"""Sports event detection processors."""

from agent.processors.detection_processor import LocalDetectionProcessor
from agent.processors.events import DetectedObject, DetectionCompletedEvent

__all__ = ["LocalDetectionProcessor", "DetectedObject", "DetectionCompletedEvent"]
