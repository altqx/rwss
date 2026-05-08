import DefaultExport, {
  AkariSub,
  AssRenderer,
  WebGPURenderer,
  WebGL2Renderer,
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
  type AkariSubCompatibleOptions,
  type ASSEvent,
  type ASSStyle,
  type EncryptedSubtitleContent,
  type PerformanceStats
} from '../src/index'

const video = document.createElement('video')
const canvas = document.createElement('canvas')
const encrypted = {} as EncryptedSubtitleContent
const eventPatch: Partial<ASSEvent> = { Text: 'hello', Start: 0, Duration: 1 }
const stylePatch: Partial<ASSStyle> = { Name: 'Default', FontName: 'sans', FontSize: 24 }

const options: AkariSubCompatibleOptions = {
  video,
  canvas,
  blendMode: 'js',
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
  renderAhead: 0.008,
  fullTrackWarmup: false
}

const renderer = new AssRenderer(options)
const rendererFromAlias = new AkariSub(options)
const rendererFromDefault = new DefaultExport(options)
const rendererType: 'canvas2d' = renderer.rendererType
renderer.resize()
renderer.setVideo(video)
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
void new WebGPURenderer(canvas)
void new WebGL2Renderer(canvas)
void computeCanvasSize(video)
void dropBlur('{\\blur5}x')
void fixPlayRes('[Script Info]\n')
void parseAss('[Script Info]\n')
void runFeatureTests()
