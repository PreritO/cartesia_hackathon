"""
Cartesia Ink Speech-to-Text plugin for Vision Agents SDK.

Uses Cartesia's Ink WebSocket STT API (ink-whisper model) for real-time
streaming transcription with built-in voice activity detection (VAD).
"""

import asyncio
import logging
import os
import time
from typing import Any, Optional

from cartesia import AsyncCartesia
from cartesia.stt._async_websocket import AsyncSttWebsocket
from getstream.video.rtc.track_util import PcmData
from vision_agents.core import stt
from vision_agents.core.edge.types import Participant
from vision_agents.core.stt import TranscriptResponse
from vision_agents.core.utils.utils import cancel_and_wait

logger = logging.getLogger(__name__)


class CartesiaSTT(stt.STT):
    """
    Cartesia Ink Speech-to-Text implementation using WebSocket streaming.

    Cartesia Ink provides built-in VAD (voice activity detection) and
    endpointing, so external turn detection is not required.

    Reference:
        - https://docs.cartesia.ai/build-with-sonic/sonic-speech-to-text
    """

    turn_detection: bool = True  # Cartesia Ink has built-in VAD

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "ink-whisper",
        language: str = "en",
        sample_rate: int = 16000,
        min_volume: Optional[float] = None,
        max_silence_duration_secs: Optional[float] = None,
        client: Optional[AsyncCartesia] = None,
    ):
        """
        Initialize Cartesia STT.

        Args:
            api_key: Cartesia API key. Falls back to CARTESIA_API_KEY env var.
            model: Model ID for transcription. Defaults to "ink-whisper".
            language: Language code in ISO-639-1 format. Defaults to "en".
            sample_rate: Audio sample rate in Hz. Defaults to 16000.
            min_volume: Volume threshold for VAD (0.0-1.0). None uses server default.
            max_silence_duration_secs: Max silence before endpointing. None uses server default.
            client: Optional pre-configured AsyncCartesia instance.
        """
        super().__init__(provider_name="cartesia")

        if not api_key:
            api_key = os.environ.get("CARTESIA_API_KEY")

        if not api_key and client is None:
            raise ValueError(
                "Cartesia API key is required. Provide api_key parameter "
                "or set CARTESIA_API_KEY environment variable."
            )

        self._api_key = api_key
        self.model = model
        self.language = language
        self.sample_rate = sample_rate
        self.min_volume = min_volume
        self.max_silence_duration_secs = max_silence_duration_secs

        self._client: Optional[AsyncCartesia] = client
        self._owns_client: bool = client is None
        self._ws: Optional[AsyncSttWebsocket] = None
        self._listen_task: Optional[asyncio.Task[None]] = None
        self._current_participant: Optional[Participant] = None
        self._connection_ready = asyncio.Event()

        # Track when audio processing started for latency measurement
        self._audio_start_time: Optional[float] = None
        # Track whether we are currently inside a speech turn
        self._in_turn: bool = False

    async def start(self) -> None:
        """
        Start the Cartesia STT WebSocket connection and begin listening.

        Creates the AsyncCartesia client (if not provided), opens the
        WebSocket connection, and spawns a background task to consume
        transcription messages.
        """
        await super().start()

        # Create client if we do not have one
        if self._client is None:
            self._client = AsyncCartesia(api_key=self._api_key)
            self._owns_client = True

        # Open WebSocket connection via the Cartesia SDK
        self._ws = await self._client.stt.websocket(
            model=self.model,
            language=self.language,
            encoding="pcm_s16le",
            sample_rate=self.sample_rate,
            min_volume=self.min_volume,
            max_silence_duration_secs=self.max_silence_duration_secs,
        )

        # Start background listener
        self._listen_task = asyncio.create_task(
            self._listen_for_transcripts(),
            name="cartesia-stt-listener",
        )

        self._connection_ready.set()
        logger.info(
            "Cartesia STT started",
            extra={"model": self.model, "language": self.language},
        )

    async def process_audio(
        self,
        pcm_data: PcmData,
        participant: Optional[Participant] = None,
    ) -> None:
        """
        Send audio data to the Cartesia WebSocket for transcription.

        Audio is resampled to 16 kHz mono before sending.

        Args:
            pcm_data: The PCM audio data to process.
            participant: The participant who produced this audio.
        """
        if self.closed:
            logger.warning("Cartesia STT is closed, ignoring audio")
            return

        # Wait for the connection to be ready
        await self._connection_ready.wait()

        if not self._connection_ready.is_set():
            logger.warning("Cartesia connection closed while processing audio")
            return

        # Resample to 16 kHz mono (required by Cartesia Ink)
        resampled_pcm = pcm_data.resample(self.sample_rate, 1)

        # Convert int16 samples to raw bytes
        audio_bytes = resampled_pcm.samples.tobytes()

        self._current_participant = participant

        # Track start time for the first audio chunk of a new utterance
        if self._audio_start_time is None:
            self._audio_start_time = time.perf_counter()

        if self._ws is not None:
            await self._ws.send(audio_bytes)

    async def _listen_for_transcripts(self) -> None:
        """
        Background task that consumes messages from the Cartesia WebSocket
        and emits the appropriate STT events.

        Message types from Cartesia:
            - "transcript" with is_final=False  -> partial transcript
            - "transcript" with is_final=True   -> final transcript (turn ended)
            - "error"                           -> transcription error
            - "flush_done"                      -> acknowledgement of finalize
            - "done"                            -> session closed
        """
        if self._ws is None:
            logger.error("WebSocket is None in listener task")
            return

        try:
            async for message in self._ws.receive():
                msg_type: str = message.get("type", "")

                if msg_type == "transcript":
                    await self._handle_transcript(message)
                elif msg_type == "error":
                    error_text = message.get("message", "Unknown Cartesia STT error")
                    logger.error("Cartesia STT error: %s", error_text)
                    self._emit_error_event(
                        error=RuntimeError(error_text),
                        context="cartesia_stt_websocket",
                        participant=self._current_participant,
                    )
                elif msg_type == "flush_done":
                    logger.debug("Cartesia STT flush acknowledged")
                elif msg_type == "done":
                    logger.debug("Cartesia STT session done")
                    break
                else:
                    logger.debug("Cartesia STT unknown message type: %s", msg_type)

        except asyncio.CancelledError:
            logger.debug("Cartesia STT listener task cancelled")
            raise
        except Exception as exc:
            logger.error("Cartesia STT listener error: %s", exc, exc_info=True)
            self._emit_error_event(
                error=exc,
                context="cartesia_stt_listener",
                participant=self._current_participant,
            )

    async def _handle_transcript(self, message: dict[str, Any]) -> None:
        """
        Process a transcript message from Cartesia and emit the
        appropriate Vision Agents STT events.

        Args:
            message: The transcript message dict from the WebSocket.
        """
        text: str = message.get("text", "").strip()
        is_final: bool = message.get("is_final", False)

        if not text:
            return

        participant = self._current_participant
        if participant is None:
            logger.warning("Received transcript but no participant set")
            return

        # Calculate processing time from first audio chunk
        processing_time_ms: Optional[float] = None
        if self._audio_start_time is not None:
            processing_time_ms = (time.perf_counter() - self._audio_start_time) * 1000

        # Extract confidence from word-level data if available
        words = message.get("words", [])
        if words:
            confidences = [
                w.get("confidence", 0.0) for w in words if isinstance(w, dict) and "confidence" in w
            ]
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
        else:
            avg_confidence = 1.0 if is_final else 0.0

        # Extract audio duration if available
        duration_ms: int = 0
        if "duration" in message:
            duration_ms = int(message["duration"] * 1000)

        # Build response metadata
        response_metadata = TranscriptResponse(
            confidence=avg_confidence,
            language=message.get("language", self.language),
            audio_duration_ms=duration_ms,
            model_name=self.model,
            processing_time_ms=processing_time_ms,
        )

        if is_final:
            # Emit final transcript
            self._emit_transcript_event(text, participant, response_metadata)
            # Emit turn ended
            self._emit_turn_ended_event(
                participant=participant,
                eager_end_of_turn=False,
                confidence=avg_confidence,
            )
            # Reset state for next utterance
            self._audio_start_time = None
            self._in_turn = False
        else:
            # If this is the first partial in a new turn, emit turn started
            if not self._in_turn:
                self._in_turn = True
                self._emit_turn_started_event(
                    participant=participant,
                    confidence=avg_confidence,
                )
            # Emit partial transcript
            self._emit_partial_transcript_event(text, participant, response_metadata)

    async def clear(self) -> None:
        """
        Flush any pending audio in the Cartesia pipeline.

        Sends the "finalize" command which causes Cartesia to process
        any buffered audio and emit a final transcript if applicable.
        """
        if self._ws is not None:
            try:
                await self._ws.send("finalize")
                logger.debug("Cartesia STT finalize sent")
            except Exception as exc:
                logger.warning("Error sending finalize to Cartesia STT: %s", exc)

    async def close(self) -> None:
        """
        Close the Cartesia STT connection and clean up all resources.

        Sends the "done" command, closes the WebSocket, cancels the
        background listener task, and optionally closes the client.
        """
        # Mark as closed first (sets self.closed = True)
        await super().close()

        self._connection_ready.clear()

        # Send "done" to signal session end
        if self._ws is not None:
            try:
                await self._ws.send("done")
            except Exception as exc:
                logger.warning("Error sending done to Cartesia STT: %s", exc)

        # Cancel the listener task
        if self._listen_task is not None:
            await cancel_and_wait(self._listen_task)
            self._listen_task = None

        # Close the WebSocket
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception as exc:
                logger.warning("Error closing Cartesia STT WebSocket: %s", exc)
            finally:
                self._ws = None

        # Close the client if we created it
        if self._owns_client and self._client is not None:
            try:
                await self._client.close()
            except Exception as exc:
                logger.warning("Error closing Cartesia client: %s", exc)
            finally:
                self._client = None

        logger.info("Cartesia STT closed")
