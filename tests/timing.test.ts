import { describe, expect, test } from 'bun:test'
import { AssRenderer } from '../src/ts/renderers'
import {
  compensatedMediaTime,
  compositorScheduleLeadMs,
  estimateRefreshIntervalMs,
  frameIndexAtOrAfter,
  isStalePresentation,
  nearestFrameIndex,
  normalizeFrameTimeline,
  presentationLeadSeconds,
  predictFrameDisplayTimeMs,
  presentedFrameIndex,
  resolvePresentationMediaTime,
  secondsToAssMs,
  selectRenderMediaTime,
  snapToFrameTimeline,
  snapToSubtitleTimeline,
  subtitleTimeForFrame,
  updateTimingCompensation
} from '../src/ts/timing'

describe('subtitle timing compensation', () => {
  test('learns bounded positive presentation lag', () => {
    expect(updateTimingCompensation(0, 1030, 1000)).toBeCloseTo(0.015)
    expect(updateTimingCompensation(0.09, 1200, 1000)).toBeCloseTo(0.095)
  })

  test('ignores throttling outliers and decays when frames meet their deadline', () => {
    expect(updateTimingCompensation(0.02, 1500, 1000)).toBe(0.02)
    expect(updateTimingCompensation(0.02, 990, 1000)).toBeCloseTo(0.018)
  })

  test('scales configured and adaptive lead by playback rate', () => {
    expect(compensatedMediaTime(10, 2, 0.01, 0.02, false)).toBeCloseTo(10.06)
    expect(compensatedMediaTime(10, 2, 0.01, 0.02, true)).toBe(10)
  })

  test('includes per-frame queue delay when predicting the painted frame', () => {
    expect(presentationLeadSeconds(110, 100, 0.02)).toBeCloseTo(0.03)
    expect(presentationLeadSeconds(80, 100, 0.01)).toBe(0)
  })

  test('uses the pipeline estimate when no RVFC deadline is available', () => {
    expect(presentationLeadSeconds(110, undefined, 0.02)).toBeCloseTo(0.02)
  })

  test('measures the physical refresh interval without counting skipped refreshes', () => {
    expect(estimateRefreshIntervalMs([6.94, 6.95, 13.89, 6.93, 20.8, 6.94])).toBeCloseTo(6.94, 2)
    expect(estimateRefreshIntervalMs([16.67, 33.33, 16.66, 16.68, 50, 16.67])).toBeCloseTo(16.67, 2)
  })

  test('predicts the next 23.976 fps compositor slot across 60 Hz cadence conversion', () => {
    const offsets = [-2002.844, -1994.655, -2003.066, -1994.677, -2003.077, -1994.788]
    expect(predictFrameDisplayTimeMs(3.9633, 1, offsets, 1710.2, 1000 / 60)).toBeCloseTo(1960.2, 1)
  })

  test('rejects presentation-stall outliers when predicting a compositor slot', () => {
    const offsets = [-2002.844, -1994.655, -2003.066, -1994.677, -2003.077, -1994.788, -1950, -1945]
    expect(predictFrameDisplayTimeMs(3.9633, 1, offsets, 1710.2, 1000 / 60)).toBeCloseTo(1960.2, 1)
  })

  test('predicts the exact six-refresh boundary on a 144 Hz display', () => {
    expect(predictFrameDisplayTimeMs(3.9633, 1, [-2921.588, -2921.588], 1000, 1000 / 144)).toBeCloseTo(1041.667, 2)
  })

  test('schedules prepared swaps inside the target refresh interval', () => {
    expect(compositorScheduleLeadMs(1000 / 60)).toBe(2)
    expect(compositorScheduleLeadMs(1000 / 144)).toBeCloseTo(1.7361, 3)
    expect(compositorScheduleLeadMs(1000 / 360)).toBeCloseTo(0.6944, 3)
    expect(compositorScheduleLeadMs(Number.NaN)).toBe(0)
  })

  test('normalizes backend frame timestamps for reusable frame sync', () => {
    expect([...normalizeFrameTimeline([0.04, Number.NaN, 0, 0.04, -1, 0.02])]).toEqual([0, 0.02, 0.04])
  })

  test('snaps predicted presentation time to the encoded frame still being presented', () => {
    const timeline = new Float64Array([0, 0.041708, 0.083417])
    expect(frameIndexAtOrAfter(timeline, 0.02)).toBe(1)
    expect(snapToFrameTimeline(timeline, 0.005)).toBe(0)
    expect(snapToFrameTimeline(timeline, 0.02)).toBe(0)
    expect(snapToFrameTimeline(timeline, 0.041707)).toBe(0)
    expect(snapToFrameTimeline(timeline, 0.041708)).toBeCloseTo(0.041708)
    expect(snapToFrameTimeline(timeline, 1)).toBeCloseTo(0.083417)
    expect(nearestFrameIndex(timeline, 0.039)).toBe(1)
    expect(nearestFrameIndex(timeline, 0.06)).toBe(1)
    expect(presentedFrameIndex(timeline, 0.02)).toBe(0)
    expect(presentedFrameIndex(timeline, 0.041707)).toBe(0)
  })

  test('does not extrapolate an exact timeline callback into future frames', () => {
    const timeline = new Float64Array([0, 0.041708, 0.083417, 0.125125, 0.166833])
    expect(selectRenderMediaTime(timeline, 0.041708, 0.166833, false)).toBeCloseTo(0.041708)
    expect(selectRenderMediaTime(timeline, 0.041708, 0.166833, true)).toBeCloseTo(0.041708)
  })

  test('maps a DTS-normalized browser frame back to the PTS-normalized subtitle clock', () => {
    const timeline = Object.assign(new Float64Array([0.083422, 0.125133, 0.166844]), {
      mediaTimeOrigin: 1.4,
      subtitleTimeOffset: 0.083422
    })

    expect(snapToSubtitleTimeline(timeline, 0.083422)).toBe(0)
    expect(snapToSubtitleTimeline(timeline, 0.125133)).toBeCloseTo(0.041711)
    expect(subtitleTimeForFrame(timeline, 2)).toBeCloseTo(0.083422)
    expect(selectRenderMediaTime(timeline, 0.166844, 0.2, false)).toBeCloseTo(0.083422)

    const normalized = normalizeFrameTimeline(timeline)
    expect(normalized.mediaTimeOrigin).toBe(1.4)
    expect(normalized.subtitleTimeOffset).toBe(0.083422)
  })

  test('rejects only paints superseded by a newer presentation', () => {
    expect(isStalePresentation(7, 8)).toBe(true)
    expect(isStalePresentation(8, 8)).toBe(false)
    expect(isStalePresentation(undefined, 8)).toBe(false)
  })

  test('uses the normalized video clock for exact timelines instead of a transport PTS', () => {
    expect(resolvePresentationMediaTime(4.375, 2.875, true)).toBe(2.875)
    expect(resolvePresentationMediaTime(4.375, 2.875, false)).toBe(4.375)
    expect(resolvePresentationMediaTime(4.375, Number.NaN, true)).toBe(4.375)
  })

  test('maps RVFC transport PTS into the exact normalized frame timeline when its origin is known', () => {
    expect(resolvePresentationMediaTime(4.375, 2.8, true, 1.5)).toBe(2.875)
    expect(resolvePresentationMediaTime(5.971, 5.89, true, 0.007)).toBeCloseTo(5.964)
    const source = Object.assign(new Float64Array([0, 0.041708]), { mediaTimeOrigin: 1.5 })
    expect(normalizeFrameTimeline(source).mediaTimeOrigin).toBe(1.5)
  })

  test('does not subtract the transport origin from Shaka-normalized RVFC timestamps', () => {
    const timeline = new Float64Array([2.837166, 2.878877, 2.920588, 2.962288])
    expect(resolvePresentationMediaTime(2.920588, 2.922556, true, 1.4, timeline)).toBe(2.920588)
  })

  test('subtracts the origin when RVFC retains the container timestamp clock', () => {
    const timeline = new Float64Array([2.878, 2.92, 2.962])
    expect(resolvePresentationMediaTime(2.927, 2.91, true, 0.007, timeline)).toBeCloseTo(2.92)
  })

  test('uses Shaka RVFC timestamps when they fit a v1 frame map better than currentTime', () => {
    const timeline = new Float64Array([3.837167, 3.878878, 3.920589, 3.962289])
    expect(resolvePresentationMediaTime(3.879877, 3.91105, true, undefined, timeline)).toBe(3.879877)
  })

  test('uses currentTime for a v1 transport timestamp that does not fit the frame map', () => {
    const timeline = new Float64Array([2.837166, 2.878877, 2.920588, 2.962288])
    expect(resolvePresentationMediaTime(4.320588, 2.922556, true, undefined, timeline)).toBe(2.922556)
  })

  test('preserves exact integer milliseconds that would otherwise floor after float multiply', () => {
    expect(secondsToAssMs(1.001)).toBe(1001)
    expect(secondsToAssMs(8.008)).toBe(8008)
    expect(secondsToAssMs(1.0015)).toBe(1001)
    expect(secondsToAssMs(0)).toBe(0)
  })
})

describe('AssRenderer exact-frame web features', () => {
  test('skips duplicate renders within the same ASS millisecond unless forced', () => {
    const canvas = {
      width: 16,
      height: 9,
      style: {},
      getContext: () => ({ clearRect() {}, drawImage() {}, putImageData() {} })
    } as unknown as HTMLCanvasElement
    const renderer = new AssRenderer({ canvas, subContent: '[Script Info]\n', autoLoad: false })
    let renders = 0
    const internals = renderer as unknown as {
      opened: { renderFrameDataAtTimestamp: (time: number) => undefined; dispose: () => void }
      paintSubtitleTime: (time: number, force: boolean) => boolean
    }
    internals.opened = {
      renderFrameDataAtTimestamp: () => {
        renders++
        return undefined
      },
      dispose() {}
    }

    internals.paintSubtitleTime(1.0011, false)
    internals.paintSubtitleTime(1.0019, false)
    expect(renders).toBe(1)
    internals.paintSubtitleTime(1.0019, true)
    expect(renders).toBe(2)
    renderer.destroy()
  })

  test('reuses static subtitle output across timestamps but not animated events', () => {
    const canvas = {
      width: 16,
      height: 9,
      style: {},
      getContext: () => ({ clearRect() {}, drawImage() {}, putImageData() {} })
    } as unknown as HTMLCanvasElement
    const renderer = new AssRenderer({ canvas, subContent: '[Script Info]\n', autoLoad: false })
    let renders = 0
    const internals = renderer as unknown as {
      opened: { renderFrameDataAtTimestamp: (time: number, options?: unknown) => undefined; dispose: () => void }
      eventRenderRanges: Array<{ index: number; startMs: number; endMs: number; timeDependent: boolean }>
      paintSubtitleTime: (time: number, force: boolean) => boolean
      bumpRenderEpoch: () => void
    }
    internals.opened = {
      renderFrameDataAtTimestamp: () => {
        renders++
        return undefined
      },
      dispose() {}
    }
    internals.eventRenderRanges = [{ index: 0, startMs: 0, endMs: 2_000, timeDependent: false }]

    internals.paintSubtitleTime(0.1, false)
    internals.paintSubtitleTime(0.2, false)
    expect(renders).toBe(1)

    internals.bumpRenderEpoch()
    internals.eventRenderRanges[0].timeDependent = true
    internals.paintSubtitleTime(0.3, false)
    internals.paintSubtitleTime(0.4, false)
    expect(renders).toBe(3)
    renderer.destroy()
  })

  test('prefetches only future frames and yields between preparation tasks', async () => {
    const canvas = {
      width: 16,
      height: 9,
      style: {},
      getContext: () => ({ clearRect() {}, drawImage() {}, putImageData() {} })
    } as unknown as HTMLCanvasElement
    const renderer = new AssRenderer({ canvas, subContent: '[Script Info]\n', autoLoad: false, framePrefetch: 2 })
    const renderedTimes: number[] = []
    const internals = renderer as unknown as {
      opened: { renderFrameDataAtTimestamp: (time: number) => undefined; dispose: () => void }
      frameTimeline: Float64Array
      eventRenderRanges: Array<{ index: number; startMs: number; endMs: number; timeDependent: boolean }>
      primePreparedFrames: (time: number) => void
      dispatchNextPreparation: () => Promise<void>
    }
    internals.opened = {
      renderFrameDataAtTimestamp: (time) => {
        renderedTimes.push(time)
        return undefined
      },
      dispose() {}
    }
    internals.frameTimeline = new Float64Array([0, 0.04, 0.08])
    internals.eventRenderRanges = [{ index: 0, startMs: 0, endMs: 1_000, timeDependent: true }]

    internals.primePreparedFrames(0)
    await internals.dispatchNextPreparation()
    expect(renderedTimes).toEqual([0.04])
    await Bun.sleep(10)
    expect(renderedTimes).toEqual([0.04, 0.08])
    renderer.destroy()
  })

  test('yields non-blocking full-track warmup work to later tasks', async () => {
    const canvas = {
      width: 16,
      height: 9,
      style: {},
      getContext: () => ({ clearRect() {}, drawImage() {}, putImageData() {} })
    } as unknown as HTMLCanvasElement
    const renderer = new AssRenderer({
      canvas,
      subContent: '[Script Info]\n',
      autoLoad: false,
      fullTrackWarmup: true,
      fullTrackWarmupStep: 0.04
    })
    const warmed: number[] = []
    const internals = renderer as unknown as {
      opened: { timestamps: Float64Array; renderAtTimestamp: (time: number) => undefined; dispose: () => void }
      maybeWarmTrack: () => Promise<void>
    }
    internals.opened = {
      timestamps: new Float64Array([0, 0.08]),
      renderAtTimestamp: (time) => {
        warmed.push(time)
        return undefined
      },
      dispose() {}
    }

    await internals.maybeWarmTrack()
    expect(warmed).toEqual([])
    await Bun.sleep(10)
    expect(warmed).toEqual([0, 0.04, 0.08])
    renderer.destroy()
  })

  test('accepts and clears an encoded-frame timeline after construction', () => {
    const canvas = {
      width: 16,
      height: 9,
      style: {},
      getContext: () => ({ clearRect() {}, drawImage() {} })
    } as unknown as HTMLCanvasElement
    const renderer = new AssRenderer({ canvas, subContent: '[Script Info]\n', autoLoad: false, framePrefetch: 24 })
    expect(renderer.framePrefetch).toBe(24)
    renderer.setFrameTimeline(new Float64Array([0, 0.041708, 0.083417]))
    renderer.setFrameTimeline(null)
    renderer.destroy()
  })

  test('clamps framePrefetch to the AkariSub 0-24 runway', () => {
    const canvas = {
      width: 16,
      height: 9,
      style: {},
      getContext: () => ({ clearRect() {}, drawImage() {} })
    } as unknown as HTMLCanvasElement
    const high = new AssRenderer({ canvas, subContent: '[Script Info]\n', autoLoad: false, framePrefetch: 99 })
    expect(high.framePrefetch).toBe(24)
    const low = new AssRenderer({ canvas, subContent: '[Script Info]\n', autoLoad: false, framePrefetch: -3 })
    expect(low.framePrefetch).toBe(0)
    high.destroy()
    low.destroy()
  })

  test('uses RVFC mediaTime instead of currentTime when presenting a video frame', () => {
    let callback: VideoFrameRequestCallback | undefined
    const video = {
      currentTime: 1.25,
      paused: false,
      ended: false,
      playbackRate: 1,
      videoWidth: 16,
      videoHeight: 9,
      getBoundingClientRect: () => ({ width: 16, height: 9 }),
      requestVideoFrameCallback: (cb: VideoFrameRequestCallback) => {
        callback = cb
        return 1
      },
      cancelVideoFrameCallback: () => {}
    } as unknown as HTMLVideoElement
    const canvas = {
      width: 16,
      height: 9,
      style: {},
      getContext: () => ({ clearRect() {}, drawImage() {} })
    } as unknown as HTMLCanvasElement
    const times: number[] = []
    const renderer = new AssRenderer({
      video,
      canvas,
      subContent: '[Script Info]\n',
      autoLoad: false,
      adaptiveTiming: false,
      onEvent: (event) => {
        if (event.type === 'render') times.push(event.time)
      }
    })
    renderer.start()
    expect(callback).toBeFunction()
    callback?.(0, { mediaTime: 0.041708, width: 16, height: 9, expectedDisplayTime: 16.67 } as VideoFrameCallbackMetadata)
    renderer.destroy()
  })
})
