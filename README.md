# rwss

High-performance browser ASS/SSA subtitle renderer powered by the pure-Rust [`rassa`](https://github.com/altqx/rassa) renderer and exported through WebAssembly.

`rwss` follows the same browser package shape as [`libbitsub`](https://github.com/altqx/libbitsub): a Rust core, a generated `wasm-bindgen` package under `pkg/`, TypeScript wrappers under `src/ts/`, and public barrel exports from `src/index.ts` / `src/wrapper.ts`. It is intentionally modern-browser-first: WASM is the only subtitle engine path, the high-level video renderer uses `requestVideoFrameCallback`, and GPU helpers target WebGPU/WebGL2 with deterministic Canvas2D/CPU fallback where needed.

## Features

- ASS/SSA parsing and rendering through `rassa` + WASM
- Automatic WASM URL resolution and browser pre-init, matching the libbitsub package pattern
- High-level video/canvas renderer (`AssRenderer`, alias `AkariSub`) with overlay canvas creation, playback sync, resize handling, and render events
- Modern browser scheduling with `HTMLVideoElement.requestVideoFrameCallback` for video-backed render loops
- ASS metadata, events, styles, timestamp list, and parser introspection APIs
- Runtime track editing helpers for events/styles, style override, default font updates, and font injection
- Browser font loading for TTF/OTF/TTC/OTC/WOFF/WOFF2 URLs or bytes, plus optional `queryLocalFonts`
- Frame export helpers for `ImageData`, `ImageBitmap`, `Blob`, and canvas targets, including direct bounds-cropped WASM output
- WebGPU and WebGL2 image-composition surfaces with direct no-readback presentation and CPU fallback for unsupported/headless runtimes
- Exact-frame `requestVideoFrameCallback` sampling with encoded `frameTimeline` maps, HLS/Shaka clock-domain detection, and integer-millisecond rassa timestamps
- Exact-frame prefetch runway (`framePrefetch`, default 2, max 24) that can defer `ready` / `trackReady` until the current frame and runway are prepared
- Adaptive presentation-latency compensation, compositor refresh-grid reanchoring, and immediate prepared-frame commit on RVFC arrival
- Static-cue reuse across video frames, while animated, karaoke, move, fade, and effect events remain time-sampled
- Custom canvases stay on the main thread by default; worker/raw ASS WebGL2 composition is an explicit opt-in
- Safety limits for fonts (32 MiB) and composed image planes (8192 images / 32M pixels)
- Worker/offscreen client/runtime protocol for OffscreenCanvas rendering handoff, including prepare/present/frame-timeline messages
- AES-GCM encrypted subtitle content transport with raw-key helpers for Akari-style handoff
- TypeScript support with exported renderer, worker, metadata, event, style, timing, and frame types

## Installation

```bash
npm install @altqx/rwss
# or
bun add @altqx/rwss
```

```bash
deno add jsr:@altq/rwss
```

```bash
cargo add rwss
```

## WASM setup

In most bundler-based projects, no manual WASM setup is required. `rwss` resolves the generated WASM asset relative to the package module URL, so bundlers such as Vite, webpack, and Rollup can emit the asset automatically.

The WASM module initializes automatically, matching libbitsub:

- high-level renderers call `initWasm()` through parser loading
- `initWasm()` imports the generated glue (`pkg/rwss.js`) and lets wasm-bindgen resolve `rwss_bg.wasm` next to that file
- workers receive both `wasmUrl` and `glueUrl` and dynamically import the glue
- importing the library triggers a non-blocking browser pre-init
- repeated `initWasm()` calls are safe and deduplicated

If your app serves package files in a way that does not expose the emitted WASM asset to the browser, copy both generated files and pass `wasmUrl`, or serve the package assets directly:

```bash
mkdir -p public/rwss
cp node_modules/@altqx/rwss/pkg/rwss_bg.wasm node_modules/@altqx/rwss/pkg/rwss.js public/rwss/
```

```ts
import { initWasm } from '@altqx/rwss'

await initWasm('/rwss/rwss_bg.wasm')
```

## Building from source

Prerequisites:

- Rust
- wasm-pack
- Bun

```bash
cargo install wasm-pack
bun run build
```

Useful development commands:

```bash
PATH="$HOME/.bun/bin:$PATH" bun run build:wasm
PATH="$HOME/.bun/bin:$PATH" bun run build:ts
PATH="$HOME/.bun/bin:$PATH" bun run test
```

## Quick start

The high-level renderer manages subtitle loading, canvas overlay creation, playback sync, browser font setup, and render timing:

```ts
import { AssRenderer } from '@altqx/rwss'

const renderer = new AssRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.ass',
  debug: true,
  onEvent: (event) => {
    if (event.type === 'render') {
      console.log('rendered frame', event.time, event.compositionCount, event.renderTime)
    }
  },
  onError: console.error
})

// later
renderer.destroy()
```

If you already have subtitle text or bytes, pass `subContent` instead of `subUrl`:

```ts
import { AssRenderer } from '@altqx/rwss'

const renderer = new AssRenderer({
  video: videoElement,
  subContent: assText
})
```

`AkariSub` is exported as an alias of `AssRenderer` for integrations that use an AkariSub-like entry point:

```ts
import { AkariSub } from '@altqx/rwss'

const renderer = new AkariSub({ video: videoElement, subUrl: '/subtitles/movie.ass' })
```

### Exact-frame timing

`rwss` sends rassa an integer millisecond timestamp. Fractional media times are floored after snapping only floating-point roundoff, matching libass's `Start <= now < Start + Duration` event boundaries. `timeOffset` and `renderAhead` are measured in seconds.

For frame-locked VOD playback, provide the encoded video's presentation timestamps. rwss prepares a small window of full subtitle frames and commits the matching frame inside `requestVideoFrameCallback`:

```ts
const frameTimeline = Object.assign(new Float64Array([0, 0.041708, 0.083417]), {
  mediaTimeOrigin: 0,
  subtitleTimeOffset: 0
})

const renderer = new AssRenderer({
  video: videoElement,
  subContent,
  frameTimeline,
  framePrefetch: 2,
  adaptiveTiming: true
})

renderer.setFrameTimeline(frameTimeline)
renderer.setFrameTimeline(null) // return to continuous-time rendering
```

Custom canvases stay on the main thread by default. Set both `offscreenRender: true` and `rawAssImageGpu: true` to opt into worker/raw-plane WebGL2 composition when dense overlays benefit from it.

## Low-level parser API

Use `openAss()` when you want in-memory parsing/rendering without a video element:

```ts
import { openAss } from '@altqx/rwss'

const subtitles = await openAss(assText)

console.log(subtitles.format)
console.log(subtitles.metadata)
console.log(subtitles.timestamps)
console.log(subtitles.getEvents())
console.log(subtitles.getStyles())

const frame = subtitles.renderAtTimestamp(120.5)
const rendered = subtitles.renderFrameDataAtTimestamp(120.5, { crop: 'bounds' })

subtitles.dispose()
```

`openAss()` initializes WASM for you and returns an `OpenedAssSubtitles` handle with:

- `metadata`
- `timestamps`
- `renderAtIndex(index)`
- `renderAtTimestamp(timeSeconds)`
- `renderFrameDataAtIndex(index, options?)`
- `renderFrameDataAtTimestamp(timeSeconds, options?)`
- `getEvents()`
- `getStyles()`
- `clearCache()`
- `dispose()`

## Frame export helpers

Parser output can be flattened into exportable RGBA pixels for previews, editors, snapshots, or visual diffing:

```ts
import { openAss, renderFrameData, toBlob, toCanvas, toImageBitmap } from '@altqx/rwss'

const subtitles = await openAss(assText)
const subtitleFrame = subtitles.renderAtTimestamp(120.5)
const rendered = subtitleFrame ? renderFrameData(subtitleFrame, { crop: 'bounds' }) : undefined

if (rendered) {
  const canvas = toCanvas(rendered)
  const bitmap = await toImageBitmap(rendered)
  const pngBlob = await toBlob(rendered)

  console.log({
    width: rendered.imageData.width,
    height: rendered.imageData.height,
    offsetX: rendered.offsetX,
    offsetY: rendered.offsetY,
    bounds: rendered.bounds,
    canvas,
    bitmap,
    pngBlob
  })
}
```

Cropping modes:

- `bounds` uses a direct WASM compositor, returns only the visible subtitle rectangle, and records its original placement via `offsetX` and `offsetY`.
- `screen` preserves the full ASS presentation dimensions for stable test fixtures or full-frame exports.

## Fonts

`rwss` registers browser-provided fonts into rassa's virtual font registry before opening a track.

```ts
import { AssRenderer } from '@altqx/rwss'

const renderer = new AssRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.ass',
  availableFonts: {
    'Noto Sans CJK JP': '/fonts/NotoSansCJKjp-Regular.otf',
    'Noto Sans': '/fonts/NotoSans-Regular.ttf'
  },
  fallbackFonts: ['Noto Sans CJK JP', 'Noto Sans'],
  useLocalFonts: true
})

await renderer.addFont('/fonts/Custom.ttf')
renderer.setDefaultFont('Noto Sans CJK JP')
```

Font inputs can be URLs, `Uint8Array`/`ArrayBuffer` bytes, or `RwssFontSource` objects with explicit `name`, `aliases`, `style`, and `isFallback` metadata. TTF, OTF, TTC, OTC, WOFF, and WOFF2 inputs are accepted. Full-name and PostScript aliases are discovered automatically; an explicitly supplied attachment takes priority over an `availableFonts` fallback with the same family.

## Encrypted subtitle transport

`rwss` can accept AES-GCM encrypted subtitle content where each chunk is IV-prefixed. Raw 128/192/256-bit key bytes or `CryptoKey` objects are accepted:

```ts
import { AssRenderer, createEncryptedSubtitleContent, importAesGcmKey } from '@altqx/rwss'

const key = await importAesGcmKey(rawKeyBytes)
const encryptedSubContent = await createEncryptedSubtitleContent(assText, key)

const renderer = new AssRenderer({
  video: videoElement,
  encryptedSubContent
})
```

You can replace tracks at runtime:

```ts
renderer.setTrackByUrl('/subtitles/episode-02.ass')
renderer.setTrack(assText)
renderer.setEncryptedTrack(encryptedSubContent)
renderer.freeTrack()
```

## Runtime ASS editing

The high-level renderer exposes AkariSub-like event/style mutation helpers. Changes rebuild the in-memory ASS document and reopen the WASM parser:

```ts
renderer.createEvent({
  Start: 1.0,
  Duration: 2.5,
  Style: 'Default',
  Text: 'Hello from rwss'
})

renderer.setEvent({ Text: 'Edited line' }, 0)
renderer.removeEvent(0)

renderer.createStyle({ Name: 'Large', FontName: 'Noto Sans', FontSize: 48 })
renderer.styleOverride({ FontSize: 42 })
renderer.disableStyleOverride()
```

## Observability events and stats

Use `onEvent` and `getStats()` to inspect renderer behavior:

```ts
const renderer = new AssRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.ass',
  onEvent: (event) => {
    switch (event.type) {
      case 'load-start':
      case 'load-complete':
      case 'track-ready':
      case 'render':
      case 'error':
      case 'message':
        console.log(event)
        break
    }
  }
})

console.log(await renderer.getStats())
console.log(renderer.getStatsSnapshot())
await renderer.resetStats()
```

`PerformanceStats` includes frame counts, render timing, learned `timingCompensationMs`, last image counts, render FPS, cache counters, and worker/offscreen/on-demand flags.

`AssRenderer` also implements `EventTarget`, so AkariSub-style `ready`, `trackReady`, `partial_ready`, and `error` events are available alongside `onEvent`.

## GPU composition helpers

Video-managed overlays use the bounds-cropped WASM + Canvas2D path by default. Set both `offscreenRender: true` and `rawAssImageGpu: true` to opt into direct WebGL2 plane presentation. For lower-level integrations, `WebGPURenderer` and `WebGL2Renderer` expose ASS image-plane composition surfaces:

```ts
import { WebGPURenderer, WebGL2Renderer, isWebGPUSupported, isWebGL2Supported } from '@altqx/rwss'

console.log({ webgpu: isWebGPUSupported(), webgl2: isWebGL2Supported() })

const gpu = new WebGPURenderer(canvas)
await gpu.present(assSubtitleData) // direct swapchain presentation
const result = await gpu.renderAsync(assSubtitleData) // explicit readback

const gl = new WebGL2Renderer(canvas)
gl.present(assSubtitleData) // direct framebuffer presentation
const glResult = gl.render(assSubtitleData) // explicit readback
```

Both GPU helpers keep their readback APIs for export/tests while `present()` avoids the synchronous GPU-to-CPU path. Unsupported/headless environments retain deterministic CPU composition.

## Worker/offscreen rendering

`AssRendererWorkerClient` provides a worker protocol for OffscreenCanvas handoff:

```ts
import { createAssRendererWorkerClient } from '@altqx/rwss'

const client = createAssRendererWorkerClient({
  canvas: offscreenCanvas,
  options: {
    subUrl: '/subtitles/movie.ass',
    offscreenRender: true
  },
  onEvent: (event) => console.log(event)
})

await client.ready
await client.renderAt(videoElement.currentTime)
client.destroy()
```

## Notes

- `rwss` handles ASS/SSA only. It does not parse bitmap subtitle formats such as PGS or VobSub; use `libbitsub` for those.
- `rwss` uses WASM as the single subtitle engine path. There is no JavaScript renderer switch or HarfBuzz GPU glyph mode.
- The default packaged fallback font is Liberation Sans (`src/default.woff2`). Configure additional fonts for CJK or custom-styled tracks.
- The project tracks AkariSub browser orchestration from `altqx/akarisub` main after v0.2.2: exact-frame timelines, prefetch runways, adaptive timing, GPU fallback, and worker protocol surfaces.

## API Reference

### Top-level exports

- `initWasm(input?, glueUrl?): Promise<WasmModule>` initializes the generated WASM package. With no arguments it imports `pkg/rwss.js` and lets wasm-bindgen resolve the `.wasm` asset. Called automatically by high-level and parser APIs; safe to call multiple times.
- `isWasmInitialized(): boolean` reports whether initialization has completed.
- `getWasm()` returns the initialized WASM module or throws if not initialized.
- `getWasmUrl()` returns the package `rwss_bg.wasm` URL resolved from `import.meta.url`.
- `getWasmGlueUrl()` returns the package `rwss.js` glue URL resolved from `import.meta.url`.
- `openAss(text, wasmUrl?): Promise<OpenedAssSubtitles>` opens an ASS/SSA document.
- `detectSubtitleFormat(nameOrText): 'ass' | 'unknown'` detects ASS/SSA by extension or text header.
- `renderFrameData(frame, options?): AssRenderedFrameData` composes an ASS frame into RGBA pixels.
- `toCanvas(frame, target?, options?)`, `toImageBitmap(frame, options?)`, and `toBlob(frame, type?, quality?, options?)` export rendered frame data.
- `registerFont(...)`, `registerAvailableFonts(...)`, `registerFontBytes(...)`, `registerFontData(...)`, `setFallbackFonts(...)`, `clearRegisteredFonts()`, `listRegisteredFonts()`, and `resolveFont(...)` manage the virtual font registry.
- `createEncryptedSubtitleContent(...)`, `decryptSubtitleContent(...)`, and `importAesGcmKey(...)` handle encrypted subtitle payloads.
- `createAssRenderer(options)` constructs a high-level `AssRenderer`.
- `WebGPURenderer`, `WebGL2Renderer`, `isWebGPUSupported()`, and `isWebGL2Supported()` expose GPU composition helpers.

### `AssRenderer`

- `constructor(options: VideoAssSubtitleOptions)` creates a video/canvas renderer.
- `load(): Promise<void>` loads the configured subtitle input.
- `start(): void` starts the render loop.
- `stop(): void` stops the render loop.
- `resize(width?, height?, top?, left?, force?): void` resizes the overlay canvas.
- `setVideo(video): void` updates the backing video element.
- `setFrameTimeline(frameTimes): void` replaces or disables the encoded-frame timeline.
- `setTrackByUrl(url): void`, `setTrack(content): void`, `setEncryptedTrack(content): void`, and `freeTrack(): void` manage subtitle tracks.
- `rendererType`, `isUsingGPURenderer`, `framePrefetch`, `renderAhead`, and `timeOffset` expose live renderer state.
- `setCurrentTime(isPaused?, currentTime?, rate?, force?): void`, `setIsPaused(isPaused): void`, and `setRate(rate): void` control manual playback state.
- `createEvent(event)`, `setEvent(event, index)`, `removeEvent(index)`, and `getEvents()` edit/read events.
- `createStyle(style)`, `setStyle(style, index)`, `removeStyle(index)`, `getStyles()`, `styleOverride(style)`, and `disableStyleOverride()` edit/read styles.
- `addFont(font, data?)` and `setDefaultFont(font)` manage fonts at runtime.
- `getStats()`, `getStatsSnapshot()`, `resetStats()`, `getEventCount()`, and `getStyleCount()` expose diagnostics.
- `runBenchmark()` emits a simple render timing message.
- `destroy(): void` disposes parser state and removes auto-created overlay canvas.

### `OpenedAssSubtitles`

- `format`, `metadata`, and `timestamps` expose track metadata.
- `renderAtIndex(index)` and `renderAtTimestamp(timeSeconds)` return ASS plane composition data.
- `renderFrameDataAtIndex(index, options?)` and `renderFrameDataAtTimestamp(timeSeconds, options?)` return flattened frame exports.
- `getEvents()` and `getStyles()` expose parsed ASS state.
- `clearCache()` clears parser-side render caches.
- `dispose()` frees parser resources.

## License

MIT
