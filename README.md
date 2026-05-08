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

Planned parity work:

- worker/offscreen rendering equivalent to AkariSub
- browser-provided font loading routed into rassa without relying on host Fontconfig
- WebGPU/WebGL2 image composition path
- AkariSub-compatible performance stats and detailed render events
- encrypted subtitle content transport if the project needs akari-crypto parity

## Development

```bash
cargo test
npm run build:wasm
npm run build:ts
```

`wasm-pack` is required for WASM builds.
