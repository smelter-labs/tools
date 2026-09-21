# Smelter Tools

A collection of browser-based utilities for working with [Smelter](https://github.com/smelter-labs) media pipelines.

**Live site:** <https://smelter-labs.github.io/tools/>

## Tools

- **Smelter Stats** — Real-time statistics dashboard for monitoring Smelter instances.
- **WHIP Streamer** — Stream your screen or camera to a Smelter instance via WebRTC WHIP.
- **WHEP Player** — Receive and play a stream from a Smelter instance via WebRTC WHEP.
- **MoQ Publish** — Publish camera, screen or a file to a MoQ relay using the `@moq/publish` library.
- **MoQ Player** — Play a MoQ broadcast from a relay using the `@moq/watch` library.
- **WAV Inspector** — Inspect WAV files and compare waveforms sample-by-sample.

There is also a **MoQ Streamer** (`#moq-streamer`), a low-level publisher that encodes H264 + AAC with
WebCodecs and pushes CMAF over Media-over-QUIC directly. It is not listed on the landing page but the
route still works.

## URLs and query parameters

Each tool lives under a hash route, e.g. `https://smelter-labs.github.io/tools/#whep-player`.
Connection details can be prefilled with query parameters after the hash:

```
#whep-player?url=https://example.com/whep&token=secret
#moq-player?url=https://relay.example.com&path=demo&jwt=...&cert=...
```

| Tool          | Route            | Parameters                     |
| ------------- | ---------------- | ------------------------------ |
| Smelter Stats | `#smelter-stats` | `url`                          |
| WHIP Streamer | `#whip-streamer` | `url`, `token`                 |
| WHEP Player   | `#whep-player`   | `url`, `token`                 |
| MoQ Publish   | `#moq-publish`   | `url`, `token`, `path`, `cert` |
| MoQ Player    | `#moq-player`    | `url`, `path`, `jwt`, `cert`   |
| MoQ Streamer  | `#moq-streamer`  | `url`, `token`, `path`, `cert` |
| WAV Inspector | `#wav-inspector` | —                              |

Values you type into a tool are kept in `sessionStorage` and take precedence over query parameters
for the rest of the browser session.

## Development

```sh
pnpm install
pnpm dev          # start Vite dev server
pnpm build        # type-check and build to dist/
pnpm lint         # eslint
pnpm format       # prettier --write
```

A Nix dev shell with Node, pnpm and the linters is available via `nix develop`.

### Adding a tool

1. Create `src/tools/<tool-id>/` with a component that accepts `{ params: URLSearchParams }` and
   exports a `meta: ToolMeta` (`id`, `name`, `description`, `scrollable`).
2. Register it in `src/tools/registry.ts`. Routes and landing-page cards are generated from that list.
   Set `hidden: true` to keep the route but leave the tool off the landing page.

## Deployment

Pushes to `main` build the site and deploy it to GitHub Pages via `.github/workflows/deploy.yml`.

## License

[MIT](LICENSE)
