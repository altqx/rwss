import DefaultExport, {
  AkariSub,
  AssRenderer,
  WebGPURenderer,
  WebGL2Renderer,
  type WrassImageCompositionResult,
  registerFont,
  registerFontBytes,
  registerAvailableFonts,
  listRegisteredFonts,
  resolveFont,
  clearRegisteredFonts,
  type WrassFontSource,
  type WrassRegisteredFont,
  type WrassResolvedFont,
  computeCanvasSize,
  dropBlur,
  fixPlayRes,
  parseAss,
  runFeatureTests,
  type VideoAssSubtitleOptions,
  type ASSEvent,
  type ASSStyle,
  type EncryptedSubtitleContent,
  type PerformanceStats,
  type FrameTimeline,
  type WrassRendererBackend
} from '../src/index'

const video = document.createElement('video')
const canvas = document.createElement('canvas')
const encrypted = {} as EncryptedSubtitleContent
const eventPatch: Partial<ASSEvent> = { Text: 'hello', Start: 0, Duration: 1 }
const stylePatch: Partial<ASSStyle> = { Name: 'Default', FontName: 'sans', FontSize: 24 }

const options: VideoAssSubtitleOptions = {
  video,
  canvas,
  asyncRender: true,
  offscreenRender: true,
  onDemandRender: true,
  targetFps: 24,
  timeOffset: 0,
  debug: true,
  prescaleFactor: 1,
  prescaleHeightLimit: 1080,
  maxRenderHeight: 720,
  dropAllAnimations: false,
  dropAllBlur: false,
  clampPos: false,
  workerUrl: '/worker.js',
  wasmUrl: '/wrass_bg.wasm',
  subContent: '[Script Info]\n',
  encryptedSubContent: encrypted,
  fonts: ['/font.ttf', new Uint8Array(), { name: 'DejaVu Sans', data: new Uint8Array(), aliases: ['Arial'] }],
  availableFonts: { sans: '/font.ttf', 'DejaVu Sans': new Uint8Array() },
  fallbackFonts: ['sans'],
  useLocalFonts: true,
  libassMemoryLimit: 64,
  libassGlyphLimit: 1024,
  onCanvasFallback() {},
  renderAhead: 0,
  adaptiveTiming: true,
  frameTimeline: Object.assign(new Float64Array([0, 0.041708, 0.083417]), { mediaTimeOrigin: 0, subtitleTimeOffset: 0 }),
  framePrefetch: 2,
  blendMode: 'wasm',
  rawAssImageGpu: false,
  useFontconfigProvider: true,
  blockingFullTrackWarmup: false,
  fullTrackWarmupStep: 1,
  adaptiveBlendLayouts: false,
  fullTrackWarmup: false
}

const renderer = new AssRenderer(options)
const rendererFromAlias = new AkariSub(options)
const rendererFromDefault = new DefaultExport(options)
const rendererType: WrassRendererBackend = renderer.rendererType
const usingGpu: boolean = renderer.isUsingGPURenderer
const usingWebGpu: boolean = renderer.isUsingWebGPU
renderer.resize()
renderer.setVideo(video)
const timeline: FrameTimeline = new Float64Array([0, 0.041708])
renderer.setFrameTimeline(timeline)
renderer.setFrameTimeline(null)
renderer.runBenchmark()
renderer.setTrackByUrl('/subtitles.ass')
renderer.setTrack('[Script Info]\n')
renderer.setTrack(new Uint8Array())
renderer.setTrack(new ArrayBuffer(0))
renderer.setEncryptedTrack(encrypted)
renderer.freeTrack()
renderer.setIsPaused(false)
renderer.setRate(1)
renderer.setCurrentTime(false, 1.25, 1)
renderer.createEvent(eventPatch)
renderer.setEvent(eventPatch, 0)
renderer.removeEvent(0)
const eventsPromise: Promise<ASSEvent[]> = renderer.getEvents()
renderer.styleOverride(stylePatch)
renderer.disableStyleOverride()
renderer.createStyle(stylePatch)
renderer.setStyle(stylePatch, 0)
renderer.removeStyle(0)
const stylesPromise: Promise<ASSStyle[]> = renderer.getStyles()
renderer.addFont('/font.ttf')
renderer.addFont(new Uint8Array())
const fontSource: WrassFontSource = { name: 'DejaVu Sans', data: new Uint8Array(), aliases: ['Arial'] }
const addFontPromise: Promise<string | undefined> = renderer.addFont(fontSource)
const addNamedFontPromise: Promise<string | undefined> = renderer.addFont('Arial', new Uint8Array())
renderer.setDefaultFont('sans')
const statsPromise: Promise<PerformanceStats> = renderer.getStats()
const resetPromise: Promise<void> = renderer.resetStats()
const eventCountPromise: Promise<number> = renderer.getEventCount()
const styleCountPromise: Promise<number> = renderer.getStyleCount()
renderer.sendMessage('debug', { ok: true })
renderer.destroy()

void rendererType
void usingGpu
void usingWebGpu
void eventsPromise
void stylesPromise
void statsPromise
void resetPromise
void eventCountPromise
void styleCountPromise
void addFontPromise
void addNamedFontPromise
const registeredFonts: WrassRegisteredFont[] = listRegisteredFonts()
const resolvedFont: WrassResolvedFont | null = resolveFont('DejaVu Sans')
const fontPathPromise: Promise<string | undefined> = registerFont(fontSource)
const directFontPath: string = registerFontBytes('Arial', new Uint8Array(), { aliases: ['Liberation Sans'] })
const registeredPathsPromise: Promise<string[]> = registerAvailableFonts({ 'DejaVu Sans': new Uint8Array() })
clearRegisteredFonts()
void registeredFonts
void resolvedFont
void fontPathPromise
void directFontPath
void registeredPathsPromise
void rendererFromAlias
void rendererFromDefault
const gpuComposition: WrassImageCompositionResult = new WebGPURenderer(canvas).render({ width: 1, height: 1, compositionData: [] })
const glComposition: WrassImageCompositionResult = new WebGL2Renderer(canvas).render({ width: 1, height: 1, compositionData: [] })
void gpuComposition
void glComposition
void computeCanvasSize(video)
void dropBlur('{\\blur5}x')
void fixPlayRes('[Script Info]\n')
void parseAss('[Script Info]\n')
void runFeatureTests()
