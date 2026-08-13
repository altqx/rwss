import {
  DEFAULT_AVAILABLE_FONTS,
  DEFAULT_FALLBACK_FONTS,
  registerFont,
  registerFontBytes,
  registerFontData,
  registerAvailableFonts,
  setFallbackFonts,
  resolveFont,
  type RwssFontSource,
  type RwssFontLoadOptions
} from '../src/index'

const bytes = new Uint8Array([0, 1, 2, 3])
const source: RwssFontSource = { data: bytes }
const namedSource: RwssFontSource = { name: 'Liberation Sans', data: bytes, aliases: ['sans', 'sans-serif'], isFallback: true }
const loadOptions: RwssFontLoadOptions = { aliases: ['Arial'], style: 'Regular', isFallback: false, timeoutMs: 1000 }

const defaultAvailable: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView> = DEFAULT_AVAILABLE_FONTS
const defaultFallback: string[] = DEFAULT_FALLBACK_FONTS

const rawPath: string = registerFontData(bytes, { name: 'Raw Bytes Font', aliases: ['raw-bytes'] })
const namedPath: string = registerFontBytes('Liberation Sans', bytes, loadOptions)
const attachedPathPromise: Promise<string | undefined> = registerFont('/fonts/LiberationSans-Regular.woff2')
const sourcePathPromise: Promise<string | undefined> = registerFont(source)
const namedSourcePathPromise: Promise<string | undefined> = registerFont(namedSource)
const registeredPromise: Promise<string[]> = registerAvailableFonts({
  'liberation sans': '/default.woff2',
  'local bytes': bytes
}, { fallbackFonts: ['liberation sans'], timeoutMs: 1000 })
setFallbackFonts(['liberation sans', 'arial'])
const resolved = resolveFont('sans-serif')

void defaultAvailable
void defaultFallback
void rawPath
void namedPath
void attachedPathPromise
void sourcePathPromise
void namedSourcePathPromise
void registeredPromise
void resolved
