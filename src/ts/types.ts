export type AssSubtitleFormatName = 'ass'
export type WrassRendererBackend = 'canvas2d' | 'webgl2' | 'webgpu'
export type WrassFrameCropMode = 'screen' | 'bounds'
export type WrassBlendMode = 'js' | 'wasm' | 'hb-gpu'

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

export interface ASSEvent {
  Start: number
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
}

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

export interface EncryptedSubtitleContent {
  /** AES-GCM content key. Raw 128/192/256-bit key bytes are accepted for akari-crypto style handoff. */
  contentKey: CryptoKey | Uint8Array | ArrayBuffer | ArrayBufferView
  encrypted?: ArrayBuffer
  encryptedChunks?: ArrayBuffer[]
}

export interface WrassPlaneData {
  x: number
  y: number
  width: number
  height: number
  stride: number
  color: number
  kind: number
  rgba: Uint8Array | number[]
}

export interface AssSubtitleData {
  width: number
  height: number
  compositionData: WrassPlaneData[]
}

export interface AssCueBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface AssRenderedFrameData {
  imageData: ImageData
  bounds: AssCueBounds | null
  offsetX: number
  offsetY: number
  screenWidth: number
  screenHeight: number
  crop: WrassFrameCropMode
  compositionCount: number
}

export interface AssFrameRenderOptions {
  crop?: WrassFrameCropMode
}

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

export interface WrassFontLoadOptions {
  name?: string
  aliases?: string[]
  style?: string
  isFallback?: boolean
  timeoutMs?: number
}

export interface WrassAvailableFontLoadOptions {
  fallbackFonts?: string[]
  timeoutMs?: number
}

export interface WrassFontSource extends WrassFontLoadOptions {
  data: Uint8Array | ArrayBuffer | ArrayBufferView
}

export interface WrassRegisteredFont {
  family: string
  aliases: string[]
  path: string
  style?: string
  isFallback?: boolean
}

export interface WrassResolvedFont {
  family: string
  path?: string
  style?: string
  syntheticBold: boolean
  syntheticItalic: boolean
  provider: string
}

export interface VideoAssSubtitleOptions {
  video?: HTMLVideoElement
  canvas?: HTMLCanvasElement
  blendMode?: WrassBlendMode
  asyncRender?: boolean
  offscreenRender?: boolean
  onDemandRender?: boolean
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
  fonts?: (string | Uint8Array | WrassFontSource)[]
  availableFonts?: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView>
  fallbackFonts?: string[]
  useLocalFonts?: boolean
  libassMemoryLimit?: number
  libassGlyphLimit?: number
  onLoading?: () => void
  onLoaded?: () => void
  onError?: (error: Error) => void
  onCanvasFallback?: () => void
  onEvent?: (event: WrassRendererEvent) => void
  renderAhead?: number
  fullTrackWarmup?: boolean
  /** Internal/advanced: set false when a worker runtime wants to await load() explicitly. */
  autoLoad?: boolean
}

export type AkariSubCompatibleOptions = VideoAssSubtitleOptions

export interface PerformanceStats {
  framesRendered: number
  framesDropped: number
  avgRenderTime: number
  maxRenderTime: number
  minRenderTime: number
  lastRenderTime: number
  pendingRenders: number
  totalEvents: number
  cacheHits: number
  cacheMisses: number
  renderFps: number
  usingWorker: boolean
  offscreenRender: boolean
  onDemandRender: boolean
}

export interface WrassRendererStatsSnapshot extends PerformanceStats {
  backend: WrassRendererBackend
}

export type SubtitleColorSpace = 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC' | null
export type WebYCbCrColorSpace = 'BT709' | 'BT601'

export interface RenderImage {
  x: number
  y: number
  w: number
  h: number
  image: ImageBitmap | ArrayBuffer | Uint8Array | Uint8ClampedArray | number
}

export interface RenderTimes {
  WASMRenderTime?: number
  WASMBitmapDecodeTime?: number
  JSRenderTime?: number
  JSBitmapGenerationTime?: number
  IPCTime?: number
  bitmaps?: number
}

export type ASSEventCallback = (error: Error | null, events: ASSEvent[]) => void
export type ASSStyleCallback = (error: Error | null, styles: ASSStyle[]) => void
export type PerformanceStatsCallback = (error: Error | null, stats: PerformanceStats | null) => void
export type ResetStatsCallback = (error: Error | null) => void

export type WrassRendererEvent =
  | { type: 'load-start' }
  | { type: 'load-complete'; metadata: AssMetadata }
  | { type: 'track-ready'; metadata: AssMetadata }
  | { type: 'render'; time: number; compositionCount: number; renderTime: number; bounds: AssCueBounds | null; backend: WrassRendererBackend; dropped: boolean }
  | { type: 'message'; target: string; data?: unknown }
  | { type: 'error'; error: Error }
