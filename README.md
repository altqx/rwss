# wrass

`wrass` is a browser-oriented ASS/SSA subtitle renderer facade built on top of the pure-Rust [`rassa`](https://github.com/altqx/rassa) renderer.

The project intentionally follows the `libbitsub` package shape:

- Rust core exported through `wasm-bindgen` in `src/lib.rs`
- generated WASM package under `pkg/`
- TypeScript wrapper in `src/ts/*`
- public barrel exports from `src/index.ts` and `src/wrapper.ts`

## Initial API

```ts
import { initWasm, openAss, AssRenderer } from 'wrass'

await initWasm()
const subtitles = await openAss(assText)
const frame = subtitles.renderFrameDataAtTimestamp(video.currentTime)

const renderer = new AssRenderer({
  video,
  subUrl: '/subtitles/example.ass'
})
```

## Feature oracle from AkariSub

AkariSub is used as the browser API/feature oracle. The current wrass scaffold maps the most important public surfaces first:

- ASS/SSA parsing and event/style inspection (`getEvents`, `getStyles`)
- timestamp rendering (`renderAtTimestamp`, `renderAtIndex`)
- flattened frame export (`renderFrameDataAtTimestamp`, `renderFrameDataAtIndex`)
- video/canvas integrated renderer (`AssRenderer`)
- options for `subUrl`, `subContent`, `wasmUrl`, `fonts`, `availableFonts`, `fallbackFonts`, `timeOffset`, `debug`, and callbacks

Implemented follow-up parity surfaces:

- worker/offscreen client/runtime protocol (`AssRendererWorkerClient`, `worker-runtime.ts`) for OffscreenCanvas rendering handoff
- browser-provided font loading routed into rassa's virtual font registry via `fonts`, `availableFonts`, `queryLocalFonts`, and fallback family aliases
- WebGPU/WebGL2 image composition facade with deterministic CPU fallback for unsupported/headless runtimes
- AkariSub-compatible performance stats plus detailed render events (`renderTime`, bounds, backend, dropped flag)
- AES-GCM encrypted subtitle content transport with IV-prefixed chunks and raw-key helpers for akari-crypto style handoff

## Development

```bash
cargo test
npm run build:wasm
npm run build:ts
```

`wasm-pack` is required for WASM builds.
