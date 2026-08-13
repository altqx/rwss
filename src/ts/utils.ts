import type { SubtitleColorSpace, WebYCbCrColorSpace } from './types'

export const webYCbCrMap: Record<string, WebYCbCrColorSpace> = {
  bt709: 'BT709',
  bt470bg: 'BT601',
  smpte170m: 'BT601'
}

export const libassYCbCrMap: Record<string, SubtitleColorSpace> = {
  'TV.601': 'BT601',
  'TV.709': 'BT709',
  'TV.240M': 'SMPTE240M',
  'TV.FCC': 'FCC'
}

export const colorMatrixConversionMap: Record<string, Record<string, string>> = {
  BT601: {
    BT709: '1.0864 -0.0723 -0.0141 0 0 0.0965 0.8451 0.0584 0 0 -0.0141 -0.0277 1.0418 0 0 0 0 0 1 0'
  },
  BT709: {
    BT601: '0.9136 0.0784 0.008 0 0 -0.105 1.1722 -0.0672 0 0 0.0096 0.0322 0.9582 0 0 0 0 0 1 0'
  }
}

export function computeCanvasSize(video: HTMLVideoElement, maxRenderHeight?: number): { width: number; height: number }
export function computeCanvasSize(
  width: number,
  height: number,
  prescaleFactor?: number,
  prescaleHeightLimit?: number,
  maxRenderHeight?: number
): { width: number; height: number }
export function computeCanvasSize(
  videoOrWidth: HTMLVideoElement | number,
  heightOrMax = 0,
  prescaleFactor = 1,
  prescaleHeightLimit = 1080,
  maxRenderHeight = 0
): { width: number; height: number } {
  if (typeof videoOrWidth !== 'number') {
    const video = videoOrWidth
    const width = video.videoWidth || Math.round(video.getBoundingClientRect().width) || 1
    const height = video.videoHeight || Math.round(video.getBoundingClientRect().height) || 1
    return computeRenderSize(width, height, 1, 1080, heightOrMax)
  }
  return computeRenderSize(videoOrWidth, heightOrMax, prescaleFactor, prescaleHeightLimit, maxRenderHeight)
}

export function computeRenderSize(
  width: number,
  height: number,
  prescaleFactor = 1,
  prescaleHeightLimit = 1080,
  maxRenderHeight = 0
): { width: number; height: number } {
  const scalefactor = prescaleFactor <= 0 ? 1 : prescaleFactor
  const ratio = globalThis.devicePixelRatio || 1
  if (height <= 0 || width <= 0) return { width: 0, height: 0 }

  const sgn = scalefactor < 1 ? -1 : 1
  let newH = height * ratio
  if (sgn * newH * scalefactor <= sgn * prescaleHeightLimit) newH *= scalefactor
  else if (sgn * newH < sgn * prescaleHeightLimit) newH = prescaleHeightLimit
  if (maxRenderHeight > 0 && newH > maxRenderHeight) newH = maxRenderHeight

  return { width: width * (newH / height), height: newH }
}

export function getVideoPosition(
  video: HTMLVideoElement,
  videoWidth: number = video.videoWidth,
  videoHeight: number = video.videoHeight
): { x: number; y: number; width: number; height: number } {
  const safeWidth = videoWidth || video.videoWidth || 0
  const safeHeight = videoHeight || video.videoHeight || 0
  const offsetWidth = video.offsetWidth || video.getBoundingClientRect().width || safeWidth
  const offsetHeight = video.offsetHeight || video.getBoundingClientRect().height || safeHeight
  if (!safeWidth || !safeHeight || !offsetWidth || !offsetHeight) {
    const rect = video.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width || 1, height: rect.height || 1 }
  }

  const videoRatio = safeWidth / safeHeight
  const elementRatio = offsetWidth / offsetHeight
  let width = offsetWidth
  let height = offsetHeight
  if (elementRatio > videoRatio) width = Math.floor(offsetHeight * videoRatio)
  else height = Math.floor(offsetWidth / videoRatio)

  return {
    width,
    height,
    x: (offsetWidth - width) / 2,
    y: (offsetHeight - height) / 2
  }
}

export function fixAlpha(data: Uint8ClampedArray | Uint8Array): Uint8ClampedArray | Uint8Array {
  for (let index = 3; index < data.length; index += 4) data[index] = Math.max(0, Math.min(255, data[index]))
  return data
}

export function parseAss(text: string): { info: Record<string, string>; styles: string[]; events: string[] } {
  const info: Record<string, string> = {}
  const styles: string[] = []
  const events: string[] = []
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (/^\[.*\]$/.test(trimmed)) section = trimmed.toLowerCase()
    else if (section === '[script info]' && trimmed.includes(':')) {
      const separator = trimmed.indexOf(':')
      info[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
    } else if (section === '[v4+ styles]' && trimmed.startsWith('Style:')) styles.push(trimmed)
    else if (section === '[events]' && /^(Dialogue|Comment):/.test(trimmed)) events.push(trimmed)
  }
  return { info, styles, events }
}

export function dropBlur(text: string): string {
  return text.replace(/\\(?:blur|be)\s*[-+]?\d*\.?\d+/gi, '')
}

export function fixPlayRes(text: string, width = 384, height = 288): string {
  const hasX = /^PlayResX:/mi.test(text)
  const hasY = /^PlayResY:/mi.test(text)
  let next = text
  if (hasX) next = next.replace(/^PlayResX:.*$/mi, `PlayResX: ${width}`)
  if (hasY) next = next.replace(/^PlayResY:.*$/mi, `PlayResY: ${height}`)
  if (!hasX || !hasY) next = next.replace(/\[Script Info\]\s*/i, `[Script Info]\n${!hasX ? `PlayResX: ${width}\n` : ''}${!hasY ? `PlayResY: ${height}\n` : ''}`)
  return next
}

export function testImageBugs(): { alphaBug: boolean; bitmapBug: boolean } {
  return { alphaBug: false, bitmapBug: false }
}

export function runFeatureTests(): { canvas2d: boolean; webgl2: boolean; webgpu: boolean; offscreenCanvas: boolean } {
  return {
    canvas2d: typeof document !== 'undefined' && !!document.createElement('canvas').getContext('2d'),
    webgl2: typeof document !== 'undefined' && !!document.createElement('canvas').getContext('webgl2'),
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined'
  }
}

export function getAlphaBug(): boolean {
  return testImageBugs().alphaBug
}

export function getBitmapBug(): boolean {
  return testImageBugs().bitmapBug
}

export function getColorSpaceFilterUrl(matrix: string): string {
  return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><filter id='f'><feColorMatrix type='matrix' values='${encodeURIComponent(matrix)}'/></filter></svg>#f")`
}
