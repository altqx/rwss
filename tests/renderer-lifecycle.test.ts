import { describe, expect, test } from 'bun:test'

import { AssRenderer } from '../src/ts/renderers'

const ROOT = new URL('..', import.meta.url).pathname

const SAMPLE_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,sans,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,cold load`

describe('AssRenderer lifecycle', () => {
  test('initializes WASM before configuring fonts on a cold high-level load', () => {
    const script = `
      import { AssRenderer } from './src/ts/renderers.ts'
      import { isWasmInitialized } from './src/ts/wasm.ts'

      if (isWasmInitialized()) throw new Error('expected a cold WASM module')
      globalThis.requestAnimationFrame = () => 1
      globalThis.cancelAnimationFrame = () => {}

      const canvas = {
        width: 320,
        height: 180,
        style: {},
        getContext: (kind) => kind === '2d' ? { clearRect() {}, drawImage() {} } : null
      }
      const renderer = new AssRenderer({
        canvas,
        subContent: ${JSON.stringify(SAMPLE_ASS)},
        autoLoad: false,
        onDemandRender: false,
        availableFonts: {},
        fallbackFonts: [],
        useLocalFonts: false
      })

      await renderer.load()
      if (!isWasmInitialized()) throw new Error('load did not initialize WASM')
      if (await renderer.getEventCount() !== 1) throw new Error('track did not finish loading')
      renderer.destroy()
      console.log('cold-load-ok')
    `
    const result = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe'
    })

    expect({
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString()
    }).toEqual({
      exitCode: 0,
      stdout: 'cold-load-ok\n',
      stderr: ''
    })
  })

  test('constructor auto-load reports a failure without an unhandled rejection', () => {
    const script = `
      import { AssRenderer } from './src/ts/renderers.ts'

      globalThis.requestAnimationFrame = () => 1
      globalThis.cancelAnimationFrame = () => {}
      const canvas = {
        width: 320,
        height: 180,
        style: {},
        getContext: (kind) => kind === '2d' ? { clearRect() {}, drawImage() {} } : null
      }
      const contentKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      )
      let reported = false
      const renderer = new AssRenderer({
        canvas,
        encryptedSubContent: { contentKey, encrypted: new Uint8Array(32).buffer },
        onError: () => { reported = true }
      })

      await Bun.sleep(20)
      if (!reported) throw new Error('auto-load failure was not reported')
      renderer.destroy()
      console.log('autoload-error-reported')
    `
    const result = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe'
    })

    expect({
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString()
    }).toEqual({
      exitCode: 0,
      stdout: 'autoload-error-reported\n',
      stderr: ''
    })
  })

  test('keeps a managed video in its original DOM parent through destroy', () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const fakeDocument = new FakeDocument()
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })

    const host = new FakeElement('div', rect(0, 0, 320, 180), true)
    const before = new FakeElement('span')
    const video = new FakeVideoElement()
    const after = new FakeElement('span')
    host.append(before, video, after)

    let renderer: AssRenderer | undefined
    try {
      renderer = new AssRenderer({
        video: video as unknown as HTMLVideoElement,
        subContent: SAMPLE_ASS,
        autoLoad: false,
        onDemandRender: false
      })

      const overlay = fakeDocument.created.find((element) => element.className === 'Rwss')
      const overlayParent = fakeDocument.created.find((element) => element.className === 'RwssContainer')
      expect(overlay).toBeDefined()
      expect(overlayParent).toBeDefined()
      expect(video.parentElement).toBe(host)
      expect(host.children).toEqual([before, video, overlayParent!, after])
      expect(overlayParent!.children).toEqual([overlay!])

      const overlayTop = overlayParent!.getBoundingClientRect().top + Number.parseFloat(overlay!.style.top)
      const overlayLeft = overlayParent!.getBoundingClientRect().left + Number.parseFloat(overlay!.style.left)
      expect(overlayTop).toBe(video.getBoundingClientRect().top)
      expect(overlayLeft).toBe(video.getBoundingClientRect().left)

      renderer.destroy()
      renderer = undefined
      expect(video.parentElement).toBe(host)
      expect(video.isConnected).toBe(true)
      expect(host.children).toEqual([before, video, after])
      expect(overlayParent!.isConnected).toBe(false)
    } finally {
      renderer?.destroy()
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })
})

type FakeRect = {
  x: number
  y: number
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

function rect(x = 0, y = 0, width = 0, height = 0): FakeRect {
  return { x, y, top: y, left: x, right: x + width, bottom: y + height, width, height }
}

class FakeElement extends EventTarget {
  readonly tagName: string
  readonly children: FakeElement[] = []
  readonly style: Record<string, string> = {}
  className = ''
  parentElement: FakeElement | null = null

  constructor(
    tagName: string,
    private readonly bounds: FakeRect = rect(),
    private readonly connectedRoot = false
  ) {
    super()
    this.tagName = tagName.toUpperCase()
  }

  get isConnected(): boolean {
    return this.connectedRoot || this.parentElement?.isConnected === true
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.detach()
      node.parentElement = this
      this.children.push(node)
    }
  }

  insertAdjacentElement(position: InsertPosition, element: FakeElement): FakeElement | null {
    if (position !== 'afterend' || !this.parentElement) return null
    element.detach()
    const index = this.parentElement.children.indexOf(this)
    element.parentElement = this.parentElement
    this.parentElement.children.splice(index + 1, 0, element)
    return element
  }

  remove(): void {
    this.detach()
  }

  getBoundingClientRect(): DOMRect {
    return this.bounds as DOMRect
  }

  private detach(): void {
    if (!this.parentElement) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
  }
}

class FakeCanvasElement extends FakeElement {
  width = 0
  height = 0
  private readonly context = {
    clearRect() {},
    drawImage() {},
    putImageData() {}
  }

  constructor() {
    super('canvas')
  }

  getContext(kind: string): typeof this.context | null {
    return kind === '2d' ? this.context : null
  }
}

class FakeVideoElement extends FakeElement {
  currentTime = 0
  paused = true
  ended = false
  playbackRate = 1
  videoWidth = 320
  videoHeight = 180
  offsetWidth = 320
  offsetHeight = 180

  constructor() {
    super('video', rect(80, 20, 320, 180))
  }
}

class FakeDocument {
  readonly created: FakeElement[] = []

  createElement(tagName: string): FakeElement {
    const element = tagName === 'canvas'
      ? new FakeCanvasElement()
      : new FakeElement(tagName, tagName === 'div' ? rect(0, 200, 320, 0) : rect())
    this.created.push(element)
    return element
  }
}
