// MediaStreamTrackProcessor and MediaStreamTrackGenerator are only declared in
// lib.webworker, not lib.dom, so we add minimal ambient declarations for
// main-thread usage. VideoFrame and AudioData themselves are provided by
// lib.dom.
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

  class MediaStreamTrackGenerator<
    T extends VideoFrame | AudioData = VideoFrame | AudioData,
  > extends MediaStreamTrack {
    constructor(init: { kind: "video" | "audio" });
    readonly writable: WritableStream<T>;
  }
}
