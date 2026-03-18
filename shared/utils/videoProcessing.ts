import type { EditorSettings, Face } from '../types/faces'
import { applyBlurEffects } from './imageProcessing'
import { createFaceResolver, expandVideoBlurFaces, refineFaceSamples, type FaceSample } from './videoFaceTracking'

export const VIDEO_PROGRESS_DETECTION_END = 0.16
export const VIDEO_PROGRESS_REFINEMENT_END = 0.24
export const VIDEO_PROGRESS_FRAME_END = 0.8

export function getDetectionIntervalFrames(fps: number, settings: EditorSettings) {
  return Math.max(1, Math.round(fps * (settings.detectionIntervalSeconds || 0.5)))
}

export async function collectFaceSamples(
  frameCount: number,
  detectionIntervalFrames: number,
  detectFacesAtFrame: (frameIndex: number) => Promise<Face[]>,
  onProgress?: (progress: number) => void
) {
  const samples: FaceSample[] = []
  const expectedSampleCount = Math.max(1, Math.ceil(frameCount / detectionIntervalFrames))

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += detectionIntervalFrames) {
    samples.push({
      frameIndex,
      faces: await detectFacesAtFrame(frameIndex)
    })
    onProgress?.((samples.length / expectedSampleCount) * VIDEO_PROGRESS_DETECTION_END)
  }

  return await refineCollectedFaceSamples(
    samples,
    frameCount,
    detectFacesAtFrame,
    onProgress
  )
}

export async function refineCollectedFaceSamples(
  samples: FaceSample[],
  frameCount: number,
  detectFacesAtFrame: (frameIndex: number) => Promise<Face[]>,
  onProgress?: (progress: number) => void
) {
  const nextSamples = [...samples]
  const lastFrameIndex = Math.max(0, frameCount - 1)

  if (nextSamples.length === 0 || nextSamples[nextSamples.length - 1]!.frameIndex !== lastFrameIndex) {
    nextSamples.push({
      frameIndex: lastFrameIndex,
      faces: await detectFacesAtFrame(lastFrameIndex)
    })
  }

  return await refineFaceSamples(nextSamples, detectFacesAtFrame, (completedIntervals, totalIntervals) => {
    const refinementRatio = completedIntervals / totalIntervals
    onProgress?.(
      VIDEO_PROGRESS_DETECTION_END
      + (refinementRatio * (VIDEO_PROGRESS_REFINEMENT_END - VIDEO_PROGRESS_DETECTION_END))
    )
  })
}

export function createVideoFaceResolver(samples: FaceSample[], fps: number) {
  return createFaceResolver(samples, {
    appearanceLookbackFrames: Math.max(1, Math.round(fps * 0.5)),
    disappearanceLookaheadFrames: Math.max(1, Math.round(fps * 0.5)),
    trajectoryWindowFrames: Math.max(1, Math.round(fps * 1))
  })
}

export function blurVideoFrame(
  frame: { data: Uint8ClampedArray, width: number, height: number },
  settings: EditorSettings,
  resolveFaces: (frameIndex: number) => Face[],
  frameIndex: number
) {
  return applyBlurEffects(
    frame,
    expandVideoBlurFaces(resolveFaces(frameIndex)),
    settings.excludedFaceIds
  )
}

export function getFrameProcessingProgress(frameIndex: number, frameCount: number) {
  return Math.min(
    VIDEO_PROGRESS_REFINEMENT_END
    + (((frameIndex + 1) / frameCount) * (VIDEO_PROGRESS_FRAME_END - VIDEO_PROGRESS_REFINEMENT_END)),
    VIDEO_PROGRESS_FRAME_END
  )
}
