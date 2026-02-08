export interface StartCaptureMessage {
  type: 'START_CAPTURE';
}

export interface StopCaptureMessage {
  type: 'STOP_CAPTURE';
}

export interface CaptureStartedMessage {
  type: 'CAPTURE_STARTED';
  streamId: string;
  tabId: number;
}

export interface CommentaryMessage {
  type: 'COMMENTARY';
  text: string;
  emotion: string;
  audio: string | null;
  annotated_frame?: string | null;
}

export interface StatusMessage {
  type: 'STATUS';
  message: string;
}

export interface StateUpdateMessage {
  type: 'STATE_UPDATE';
  state: CommentatorState;
}

export interface CommentatorState {
  active: boolean;
  status: string;
  tabId: number | null;
  videoId: string | null;
}

export interface MuteTabVideoMessage {
  type: 'MUTE_TAB_VIDEO';
}

export interface UnmuteTabVideoMessage {
  type: 'UNMUTE_TAB_VIDEO';
}

export type ExtensionMessage =
  | StartCaptureMessage
  | StopCaptureMessage
  | CaptureStartedMessage
  | CommentaryMessage
  | StatusMessage
  | StateUpdateMessage
  | MuteTabVideoMessage
  | UnmuteTabVideoMessage;
