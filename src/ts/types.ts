/** ASS/SSA format identifier. */
export type AssSubtitleFormatName = 'ass'
/** Active presentation backend for composed ASS frames. */
export type RwssRendererBackend = 'canvas2d' | 'webgl2' | 'webgpu'
/** Whether composed frames keep the full PlayRes screen or crop to ink bounds. */
export type RwssFrameCropMode = 'screen' | 'bounds'

/** Parsed ASS script metadata returned by the WASM parser. */
export interface AssMetadata {
  format: AssSubtitleFormatName
  cueCount: number
  styleCount: number
  attachmentCount: number
  playResX: number
  playResY: number
  layoutResX: number
  layoutResY: number
  wrapStyle: number
  scaledBorderAndShadow: boolean
  language: string
}

/** Maximum accepted font file size in bytes (32 MiB). */
export const MAX_FONT_BYTES = 32 * 1024 * 1024
/** Maximum ASS image planes accepted in one composed frame. */
export const MAX_RENDER_IMAGES = 8192
/** Maximum total pixels accepted across composed ASS image planes. */
export const MAX_RENDER_PIXELS = 32 * 1024 * 1024
/** Maximum exact-frame prefetch runway accepted by AssRenderer. */
export const MAX_FRAME_PREFETCH = 24

/** One ASS dialogue or comment event. */
export interface ASSEvent {
  /** Start time in seconds. */
  Start: number
  /** Duration in seconds. */
  Duration: number
  Style: string
  Name: string
  MarginL: number
  MarginR: number
  MarginV: number
  Effect: string
  Text: string
  ReadOrder: number
  Layer: number
  _index?: number
}

/** One ASS style record. */
export interface ASSStyle {
  Name: string
  FontName: string
  FontSize: number
  PrimaryColour: number
  SecondaryColour: number
  OutlineColour: number
  BackColour: number
  Bold: number
  Italic: number
  Underline: number
  StrikeOut: number
  ScaleX: number
  ScaleY: number
  Spacing: number
  Angle: number
  BorderStyle: number
  Outline: number
  Shadow: number
  Alignment: number
  MarginL: number
  MarginR: number
  MarginV: number
  Encoding: number
  TreatFontnameAsPattern: number
  Blur: number
  Justify: number
}

/** AES-GCM encrypted subtitle payload used for Akari-style handoff. */
export interface EncryptedSubtitleContent {
  /** AES-GCM content key. Raw 128/192/256-bit key bytes are accepted for akari-crypto style handoff. */
  contentKey: CryptoKey | Uint8Array | ArrayBuffer | ArrayBufferView
  encrypted?: ArrayBuffer
  encryptedChunks?: ArrayBuffer[]
}

/** One rassa/libass image plane in RGBA. */
export interface RwssPlaneData {
  x: number
  y: number
  width: number
  height: number
  stride: number
  color: number
  kind: number
  rgba: Uint8Array | number[]
}

/** Raw ASS composition for a single timestamp. */
export interface AssSubtitleData {
  width: number
  height: number
  compositionData: RwssPlaneData[]
}

/** Axis-aligned bounds of visible subtitle ink. */
export interface AssCueBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Flattened RGBA frame plus placement metadata. */
export interface AssRenderedFrameData {
  imageData: ImageData
  bounds: AssCueBounds | null
  offsetX: number
  offsetY: number
  screenWidth: number
  screenHeight: number
  crop: RwssFrameCropMode
  compositionCount: number
}

/** Options for flattening ASS planes into RGBA. */
export interface AssFrameRenderOptions {
  crop?: RwssFrameCropMode
}

/** In-memory ASS document handle returned by openAss(). */
export interface OpenedAssSubtitles {
  readonly format: AssSubtitleFormatName
  readonly metadata: AssMetadata
  readonly timestamps: Float64Array
  renderAtIndex(index: number): AssSubtitleData | undefined
  renderAtTimestamp(timeSeconds: number): AssSubtitleData | undefined
  renderFrameDataAtIndex(index: number, options?: AssFrameRenderOptions): AssRenderedFrameData | undefined
  renderFrameDataAtTimestamp(timeSeconds: number, options?: AssFrameRenderOptions): AssRenderedFrameData | undefined
  getEvents(): ASSEvent[]
  getStyles(): ASSStyle[]
  clearCache(): void
  dispose(): void
}

/** Options when registering a single font. */
export interface RwssFontLoadOptions {
  name?: string
  aliases?: string[]
  style?: string
  isFallback?: boolean
  timeoutMs?: number
}

/** Options when registering a named font map. */
export interface RwssAvailableFontLoadOptions {
  fallbackFonts?: string[]
  timeoutMs?: number
}

/** In-memory font bytes plus optional family metadata. */
export interface RwssFontSource extends RwssFontLoadOptions {
  data: Uint8Array | ArrayBuffer | ArrayBufferView
}

/** Font currently registered in the virtual font registry. */
export interface RwssRegisteredFont {
  family: string
  aliases: string[]
  path: string
  style?: string
  isFallback?: boolean
}

/** Font selected for a family query. */
export interface RwssResolvedFont {
  family: string
  path?: string
  style?: string
  syntheticBold: boolean
  syntheticItalic: boolean
  provider: string
}

/** Encoded-frame timestamps with optional media/subtitle clock offsets. */
export interface FrameTimeline extends ArrayLike<number> {
  mediaTimeOrigin?: number
  subtitleTimeOffset?: number
}

/** Construction options for AssRenderer / AkariSub. */
export interface VideoAssSubtitleOptions {
  video?: HTMLVideoElement
  canvas?: HTMLCanvasElement
  /** Image blending mode: 'js' for hardware acceleration, 'wasm' for software. */
  blendMode?: 'js' | 'wasm'
  /** Use async rendering with ImageBitmap (default: true on Canvas2D paths). */
  asyncRender?: boolean
  /** Use offscreen canvas rendering (default: true for video-managed canvases, false for custom canvases). */
  offscreenRender?: boolean
  /** Compose raw ASS image planes with WebGL2 (default: false; custom canvases stay main-thread). */
  rawAssImageGpu?: boolean
  /** Use requestVideoFrameCallback for precise sync (default: true). */
  onDemandRender?: boolean
  /** Compensate measured render/presentation latency while playing (default: true). */
  adaptiveTiming?: boolean
  /** Encoded video-frame timestamps and optional RVFC media-time origin, in seconds. */
  frameTimeline?: FrameTimeline
  /** Number of exact subtitle frames to prepare ahead (default: 2, maximum 24). */
  framePrefetch?: number
  targetFps?: number
  timeOffset?: number
  debug?: boolean
  prescaleFactor?: number
  prescaleHeightLimit?: number
  maxRenderHeight?: number
  dropAllAnimations?: boolean
  dropAllBlur?: boolean
  clampPos?: boolean
  workerUrl?: string
  wasmUrl?: string
  subUrl?: string
  subContent?: string | Uint8Array | ArrayBuffer
  encryptedSubContent?: EncryptedSubtitleContent
  fonts?: (string | Uint8Array | RwssFontSource)[]
  availableFonts?: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView>
  fallbackFonts?: string[]
  useLocalFonts?: boolean
  /** Use the virtual fontconfig provider for packaged font lookup (default: true). */
  useFontconfigProvider?: boolean
  libassMemoryLimit?: number
  libassGlyphLimit?: number
  onLoading?: () => void
  onLoaded?: () => void
  onError?: (error: Error) => void
  onCanvasFallback?: () => void
  onEvent?: (event: RwssRendererEvent) => void
  renderAhead?: number
  fullTrackWarmup?: boolean
  /** Wait for fullTrackWarmup to finish before ready (default: false). */
  blockingFullTrackWarmup?: boolean
  /** Step in seconds for fullTrackWarmup (default: 1). */
  fullTrackWarmupStep?: number
  /** Allow adaptive CPU preblend layouts for text-heavy frames (default: false). */
  adaptiveBlendLayouts?: boolean
  /** Internal/advanced: set false when a worker runtime wants to await load() explicitly. */
  autoLoad?: boolean
}

/** @deprecated Use VideoAssSubtitleOptions. */
export type AkariSubOptions = VideoAssSubtitleOptions

/** Renderer counters and last-frame timing. */
export interface PerformanceStats {
  framesRendered: number
  framesDropped: number
  avgRenderTime: number
  maxRenderTime: number
  minRenderTime: number
  lastRenderTime: number
  /** Current automatically learned presentation-latency compensation in milliseconds. */
  timingCompensationMs?: number
  /** Number of image planes emitted by the last render. */
  lastImageCount?: number
  /** Total RGBA/raw image pixels emitted by the last render. */
  lastImagePixels?: number
  pendingRenders: number
  totalEvents: number
  cacheHits: number
  cacheMisses: number
  renderFps: number
  usingWorker: boolean
  /** Whether raw ASS_Image GPU composition is active. */
  rawAssImageGpu?: boolean
  workerRenderer?: 'webgl2-raw-ass' | 'canvas2d' | 'hybrid' | 'main-thread'
  offscreenRender: boolean
  onDemandRender: boolean
}

/** Performance stats plus the active backend. */
export interface RwssRendererStatsSnapshot extends PerformanceStats {
  backend: RwssRendererBackend
}

/** libass YCbCr color-space name, or null when unknown. */
export type SubtitleColorSpace = 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC' | null
/** Browser YCbCr color-space name used for CSS filters. */
export type WebYCbCrColorSpace = 'BT709' | 'BT601'

/** One decoded bitmap or buffer to composite. */
export interface RenderImage {
  x: number
  y: number
  w: number
  h: number
  image: ImageBitmap | ArrayBuffer | Uint8Array | Uint8ClampedArray | number
}

/** Raw ASS_Image plane for GPU mask composition. */
export interface RawASSImage {
  dst_x: number
  dst_y: number
  w: number
  h: number
  bitmap: number
  color: number
  stride: number
  type: number
}

/** Subset of HTMLVideoElement.requestVideoFrameCallback metadata. */
export interface VideoFrameCallbackMetadata {
  mediaTime: number
  width: number
  height: number
  presentedFrames?: number
  processingDuration?: number
  expectedDisplayTime?: number
  presentationTime?: number
}

/** Worker outbound message carrying a composed frame. */
export interface RenderMessage {
  target: 'render'
  asyncRender?: boolean
  images: RenderImage[]
  times: RenderTimes
  width: number
  height: number
  colorSpace: string | null
  requestId?: number
  renderEpoch?: number
  presentationId?: number
}

/** Optional per-stage render timing breakdown. */
export interface RenderTimes {
  WASMRenderTime?: number
  WASMBitmapDecodeTime?: number
  JSRenderTime?: number
  JSBitmapGenerationTime?: number
  IPCTime?: number
  bitmaps?: number
}

/** Messages posted from the rwss worker runtime. */
export type WorkerOutboundMessage =
  | { target: 'ready' }
  | { target: 'trackReady' }
  | { target: 'partial_ready' }
  | { target: 'unbusy'; requestId?: number; renderEpoch?: number; presentationId?: number; painted?: boolean }
  | { target: 'console'; command: string; content: string }
  | { target: 'getLocalFont'; font: string }
  | { target: 'verifyColorSpace'; subtitleColorSpace: string | null }
  | { target: 'getEvents'; events: ASSEvent[] }
  | { target: 'getStyles'; styles: ASSStyle[]; time: number }
  | { target: 'getStats'; stats: Partial<PerformanceStats> }
  | { target: 'resetStats'; success: boolean }
  | { target: 'getEventCount'; count: number }
  | { target: 'getStyleCount'; count: number }
  | { target: 'prepared'; prepareId: number; renderEpoch: number; time: number; width: number; height: number; bitmap?: ImageBitmap }
  | { target: 'presented'; presentationId: number; renderEpoch?: number; frameIndex?: number }
  | RenderMessage

/** Worker init payload for OffscreenCanvas rendering. */
export interface WorkerInitMessage {
  target: 'init'
  wasmUrl: string
  glueUrl?: string
  asyncRender: boolean
  fullTrackWarmup: boolean
  blockingFullTrackWarmup?: boolean
  fullTrackWarmupStep?: number
  adaptiveBlendLayouts?: boolean
  rawAssImageGpu?: boolean
  onDemandRender: boolean
  initialTime: number
  initialIsPaused?: boolean
  initialPlaybackRate?: number
  initialTimeSnapshotAtMs?: number
  width: number
  height: number
  blendMode?: 'js' | 'wasm'
  subUrl?: string
  subContent?: string | Uint8Array | ArrayBuffer | null
  encryptedSubContent?: EncryptedSubtitleContent | null
  fonts: (string | Uint8Array)[]
  availableFonts: Record<string, string | Uint8Array>
  fallbackFonts: string[]
  debug: boolean
  targetFps: number
  renderAhead?: number
  adaptiveTiming?: boolean
  frameTimelineMode?: boolean
  dropAllAnimations?: boolean
  dropAllBlur?: boolean
  clampPos?: boolean
  libassMemoryLimit?: number
  libassGlyphLimit?: number
  useLocalFonts: boolean
  useFontconfigProvider?: boolean
  hasBitmapBug: boolean
}

/** Messages posted to the rwss worker runtime. */
export type WorkerInboundMessage =
  | WorkerInitMessage
  | { target: 'offscreenCanvas'; rawAssImageGpu?: boolean; transferable: [OffscreenCanvas] }
  | { target: 'detachOffscreen' }
  | { target: 'canvas'; width: number; height: number; videoWidth: number; videoHeight: number; force?: boolean }
  | {
      target: 'video'
      currentTime?: number
      isPaused?: boolean
      rate?: number
      renderAhead?: number
      colorSpace?: string | null
    }
  | { target: 'setTrack'; content: string | Uint8Array | ArrayBuffer }
  | { target: 'setEncryptedTrack'; content: EncryptedSubtitleContent }
  | { target: 'setTrackByUrl'; url: string }
  | { target: 'freeTrack' }
  | {
      target: 'demand'
      time: number
      force?: boolean
      requestId?: number
      renderEpoch?: number
      presentationId?: number
    }
  | { target: 'prepare'; time: number; prepareId: number; renderEpoch: number; force?: boolean }
  | { target: 'presentation'; presentationId: number }
  | { target: 'presentFrame'; bitmap: ImageBitmap; presentationId: number }
  | { target: 'frameTimelineMode'; enabled: boolean }
  | { target: 'destroy' }
  | { target: 'addFont'; font: string | Uint8Array }
  | { target: 'defaultFont'; font: string }
  | { target: 'createEvent'; event: Partial<ASSEvent> }
  | { target: 'setEvent'; event: Partial<ASSEvent>; index: number }
  | { target: 'removeEvent'; index: number }
  | { target: 'getEvents' }
  | { target: 'createStyle'; style: Partial<ASSStyle> }
  | { target: 'setStyle'; style: Partial<ASSStyle>; index: number }
  | { target: 'removeStyle'; index: number }
  | { target: 'getStyles' }
  | { target: 'styleOverride'; style: Partial<ASSStyle> }
  | { target: 'disableStyleOverride' }
  | { target: 'getStats' }
  | { target: 'resetStats' }
  | { target: 'getEventCount' }
  | { target: 'getStyleCount' }
  | { target: 'runBenchmark' }
  | { target: 'getColorSpace' }

/** Callback receiving the current ASS event list. */
export type ASSEventCallback = (error: Error | null, events: ASSEvent[]) => void
/** Callback receiving the current ASS style list. */
export type ASSStyleCallback = (error: Error | null, styles: ASSStyle[]) => void
/** Callback receiving renderer performance stats. */
export type PerformanceStatsCallback = (error: Error | null, stats: PerformanceStats | null) => void
/** Callback fired after stats are reset. */
export type ResetStatsCallback = (error: Error | null) => void

/** Observability event emitted by AssRenderer. */
export type RwssRendererEvent =
  | { type: 'load-start' }
  | { type: 'load-complete'; metadata: AssMetadata }
  | { type: 'track-ready'; metadata: AssMetadata }
  | { type: 'partial-ready' }
  | { type: 'render'; time: number; compositionCount: number; renderTime: number; bounds: AssCueBounds | null; backend: RwssRendererBackend; dropped: boolean }
  | { type: 'message'; target: string; data?: unknown }
  | { type: 'error'; error: Error }
