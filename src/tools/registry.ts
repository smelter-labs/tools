// Every tool page registers itself here. `App.tsx` builds the routes and the landing-page
// cards from this list, so adding a tool is one folder plus one entry below.
import type { ComponentType } from "react";
import SmelterStats, { meta as smelterStats } from "./smelter-stats/SmelterStats.tsx";
import WhipStreamer, { meta as whipStreamer } from "./whip-streamer/WhipStreamer.tsx";
import WhepPlayer, { meta as whepPlayer } from "./whep-player/WhepPlayer.tsx";
import MoqStreamer, { meta as moqStreamer } from "./moq-streamer/MoqStreamer.tsx";
import MoqPublish, { meta as moqPublish } from "./moq-publish/MoqPublish.tsx";
import MoqPlayer, { meta as moqPlayer } from "./moq-player/MoqPlayer.tsx";
import WavInspector, { meta as wavInspector } from "./wav-inspector/WavInspector.tsx";

/** Card and routing metadata a tool exports next to its component. */
export interface ToolMeta {
  /** URL hash the tool lives under, e.g. `#moq-player`. */
  id: string;
  name: string;
  description: string;
  /** Whether the page scrolls as a document or fills the viewport with its own layout. */
  scrollable: boolean;
}

export interface Tool extends ToolMeta {
  component: ComponentType<{ params: URLSearchParams }>;
}

export const TOOLS: Tool[] = [
  { ...smelterStats, component: SmelterStats },
  { ...whipStreamer, component: WhipStreamer },
  { ...whepPlayer, component: WhepPlayer },
  { ...moqStreamer, component: MoqStreamer },
  { ...moqPublish, component: MoqPublish },
  { ...moqPlayer, component: MoqPlayer },
  { ...wavInspector, component: WavInspector },
];
