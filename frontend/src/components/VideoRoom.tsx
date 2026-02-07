/**
 * VideoRoom - Stream Video SDK room for displaying the sports broadcast.
 *
 * Joins a Stream Video call by ID and renders the video/audio
 * using the SpeakerLayout component from the SDK.
 */

import { useEffect, useState } from "react";
import {
  StreamCall,
  SpeakerLayout,
  StreamVideoClient,
  CallingState,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import type { Call } from "@stream-io/video-react-sdk";

interface VideoRoomProps {
  client: StreamVideoClient;
  callId: string;
}

/**
 * Inner component that renders once we are inside a <StreamCall> context.
 * Uses the SDK hooks to display connection state and the video layout.
 */
function CallUI() {
  const { useCallCallingState, useParticipantCount } = useCallStateHooks();
  const callingState = useCallCallingState();
  const participantCount = useParticipantCount();

  if (callingState === CallingState.JOINING) {
    return (
      <div className="flex h-full items-center justify-center text-white">
        <div className="text-center">
          <div className="mb-4 text-xl font-semibold">Joining call...</div>
          <div className="text-sm text-gray-400">
            Connecting to the broadcast
          </div>
        </div>
      </div>
    );
  }

  if (callingState === CallingState.LEFT) {
    return (
      <div className="flex h-full items-center justify-center text-white">
        <div className="text-xl font-semibold">Call ended</div>
      </div>
    );
  }

  if (
    callingState === CallingState.RECONNECTING ||
    callingState === CallingState.MIGRATING
  ) {
    return (
      <div className="flex h-full items-center justify-center text-white">
        <div className="text-xl font-semibold">Reconnecting...</div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <SpeakerLayout />
      <div className="absolute bottom-4 left-4 rounded bg-black/60 px-3 py-1 text-sm text-white">
        {participantCount} participant{participantCount !== 1 ? "s" : ""}
      </div>
    </div>
  );
}

export function VideoRoom({ client, callId }: VideoRoomProps) {
  const [call, setCall] = useState<Call | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const newCall = client.call("default", callId);

    newCall
      .join({ create: true })
      .then(() => {
        setCall(newCall);
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Failed to join call";
        console.error("[VideoRoom] Failed to join call:", err);
        setError(message);
      });

    return () => {
      newCall.leave().catch((err: unknown) => {
        console.warn("[VideoRoom] Error leaving call:", err);
      });
      setCall(null);
    };
  }, [client, callId]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <div className="mb-2 text-xl font-semibold text-red-400">
            Connection Error
          </div>
          <div className="text-sm text-gray-400">{error}</div>
          <button
            className="mt-4 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!call) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <div className="mb-4 text-xl font-semibold">
            Connecting to broadcast...
          </div>
          <div className="text-sm text-gray-400">Call ID: {callId}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-gray-950">
      <StreamCall call={call}>
        <CallUI />
      </StreamCall>
    </div>
  );
}
