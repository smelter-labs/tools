// MediaStreamTrackProcessor is only declared in lib.webworker, not lib.dom, so
// we add a minimal ambient declaration for main-thread usage. VideoFrame and
// AudioData themselves are provided by lib.dom.
export {};

declare global {
  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack;
    maxBufferSize?: number;
  }

  class MediaStreamTrackProcessor<T extends VideoFrame | AudioData = VideoFrame | AudioData> {
    constructor(init: MediaStreamTrackProcessorInit);
    readonly readable: ReadableStream<T>;
  }
}
