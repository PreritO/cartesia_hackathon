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
}

export type ExtensionMessage =
  | StartCaptureMessage
  | StopCaptureMessage
  | CaptureStartedMessage
  | CommentaryMessage
  | StatusMessage
  | StateUpdateMessage;
