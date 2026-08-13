import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import init, {
  clearRegisteredFonts,
  listRegisteredFonts,
  openAss,
  registerFontData,
  resolveFont,
  setFallbackFonts
} from '../pkg/rwss.js'

const ROOT = new URL('..', import.meta.url).pathname
const ARTIFACT_DIR = join(ROOT, 'tests', 'artifacts')
const WASM_PATH = join(ROOT, 'pkg', 'rwss_bg.wasm')
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
]

const SAMPLE_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Missing Browser Font,42,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,30,30,34,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0000,0000,0000,,{\\bord3\\shad1}rwss e2e render`

describe('rwss browser/WASM rendering e2e', () => {
  test('renders ASS text through WASM + virtual fontconfig and writes a PNG artifact', async () => {
    const fontPath = await findUsableFont()
    const [wasmBytes, fontBytes] = await Promise.all([readFile(WASM_PATH), readFile(fontPath)])

    await init({ module_or_path: wasmBytes })
    clearRegisteredFonts()
    const virtualPath = registerFontData(new Uint8Array(fontBytes), {
      aliases: ['Missing Browser Font', 'sans', 'liberation sans'],
      isFallback: true
    })
    setFallbackFonts(['Missing Browser Font', 'sans'])

    const resolvedExact = resolveFont('Missing Browser Font')
    const resolvedFallback = resolveFont('Definitely Missing Family')
    expect(virtualPath).toStartWith('/rwss-fontconfig/')
    expect(listRegisteredFonts().length).toBeGreaterThanOrEqual(1)
    expect(resolvedExact?.provider).toBe('Attached')
    expect(resolvedFallback?.provider).toBe('Attached')

    const parser = openAss(SAMPLE_ASS)
    const frame = parser.renderAtTimestamp(0.75)
    expect(frame.width).toBe(640)
    expect(frame.height).toBe(360)
    expect(frame.compositionData.length).toBeGreaterThan(0)

    const rgba = compositePlanes(frame.width, frame.height, frame.compositionData)
    const coverage = alphaCoverage(rgba)
    expect(coverage.nonTransparentPixels).toBeGreaterThan(1000)
    expect(coverage.alphaSum).toBeGreaterThan(100_000)

    await mkdir(ARTIFACT_DIR, { recursive: true })
    const artifactPath = join(ARTIFACT_DIR, 'e2e-render.png')
    await Bun.write(artifactPath, encodePng(frame.width, frame.height, rgba))
    const png = await readFile(artifactPath)
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(png.byteLength).toBeGreaterThan(2048)

    parser.free()
  })
})

async function findUsableFont(): Promise<string> {
  for (const path of FONT_CANDIDATES) {
    try {
      const info = await stat(path)
      if (info.isFile() && info.size > 0) return path
    } catch {
      // Keep probing portable Linux font locations.
    }
  }
  throw new Error(`No TTF font found for e2e render smoke. Probed: ${FONT_CANDIDATES.join(', ')}`)
}

type Plane = {
  x: number
  y: number
  width: number
  height: number
  rgba: Uint8Array | number[]
}

function compositePlanes(width: number, height: number, planes: Plane[]): Uint8Array {
  const target = new Uint8Array(width * height * 4)
  for (const plane of planes) {
    const source = plane.rgba instanceof Uint8Array ? plane.rgba : new Uint8Array(plane.rgba)
    for (let py = 0; py < plane.height; py++) {
      const y = plane.y + py
      if (y < 0 || y >= height) continue
      for (let px = 0; px < plane.width; px++) {
        const x = plane.x + px
        if (x < 0 || x >= width) continue
        const src = (py * plane.width + px) * 4
        const dst = (y * width + x) * 4
        const sa = source[src + 3] / 255
        if (sa <= 0) continue
        const da = target[dst + 3] / 255
        const oa = sa + da * (1 - sa)
        target[dst] = Math.round(((source[src] / 255) * sa + (target[dst] / 255) * da * (1 - sa)) / oa * 255)
        target[dst + 1] = Math.round(((source[src + 1] / 255) * sa + (target[dst + 1] / 255) * da * (1 - sa)) / oa * 255)
        target[dst + 2] = Math.round(((source[src + 2] / 255) * sa + (target[dst + 2] / 255) * da * (1 - sa)) / oa * 255)
        target[dst + 3] = Math.round(oa * 255)
      }
    }
  }
  return target
}

function alphaCoverage(rgba: Uint8Array): { nonTransparentPixels: number; alphaSum: number } {
  let nonTransparentPixels = 0
  let alphaSum = 0
  for (let i = 3; i < rgba.length; i += 4) {
    const alpha = rgba[i]
    if (alpha > 0) nonTransparentPixels++
    alphaSum += alpha
  }
  return { nonTransparentPixels, alphaSum }
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const chunks = [pngChunk('IHDR', ihdr(width, height)), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]))
}

function ihdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = 8
  data[9] = 6
  data[10] = 0
  data[11] = 0
  data[12] = 0
  return data
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0)
  return Buffer.concat([length, name, data, crc])
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
