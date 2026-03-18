import type { Face } from '../types/faces'

const VIDEO_BLUR_SCALE = 1.5
const FACE_MATCH_MAX_SCORE = 2.4
const HIGH_CONFIDENCE_FACE = 0.9

export interface FaceSample {
  frameIndex: number
  faces: Face[]
}

interface FaceResolverOptions {
  appearanceLookbackFrames?: number
  disappearanceLookaheadFrames?: number
  trajectoryWindowFrames?: number
}

interface FaceTrajectoryPoint {
  frameIndex: number
  face: Face
}

interface FacePair {
  from?: Face
  to?: Face
  appearanceExtension?: {
    startFrame: number
    trajectory: FaceTrajectoryPoint[]
  } | null
  disappearanceExtension?: {
    endFrame: number
    trajectory: FaceTrajectoryPoint[]
  } | null
}

interface FaceSegment {
  startFrame: number
  endFrame: number
  pairs: FacePair[]
}

type FaceMatcher = (targetFace: Face, candidateFace: Face, score: number) => boolean

function cloneFace(face: Face) {
  return {
    ...face
  }
}

function lerp(start: number, end: number, t: number) {
  return start + ((end - start) * t)
}

function centerDistance(faceA: Face, faceB: Face) {
  const ax = faceA.x + (faceA.width / 2)
  const ay = faceA.y + (faceA.height / 2)
  const bx = faceB.x + (faceB.width / 2)
  const by = faceB.y + (faceB.height / 2)

  return Math.hypot(ax - bx, ay - by)
}

function overlapRatio(faceA: Face, faceB: Face) {
  const left = Math.max(faceA.x, faceB.x)
  const top = Math.max(faceA.y, faceB.y)
  const right = Math.min(faceA.x + faceA.width, faceB.x + faceB.width)
  const bottom = Math.min(faceA.y + faceA.height, faceB.y + faceB.height)
  const intersectionWidth = Math.max(0, right - left)
  const intersectionHeight = Math.max(0, bottom - top)
  const intersectionArea = intersectionWidth * intersectionHeight

  if (intersectionArea <= 0) {
    return 0
  }

  const smallestArea = Math.max(1, Math.min(faceA.width * faceA.height, faceB.width * faceB.height))
  return intersectionArea / smallestArea
}

function isHighConfidenceMatch(faceA: Face, faceB: Face) {
  const closeEnough = centerDistance(faceA, faceB) <= Math.max(faceA.width, faceA.height, faceB.width, faceB.height) * 2.5
  const overlapEnough = overlapRatio(faceA, faceB) >= 0.1

  return (
    Math.max(faceA.confidence, faceB.confidence) >= HIGH_CONFIDENCE_FACE
    && (closeEnough || overlapEnough)
  )
}

function canMatchFaces(faceA: Face, faceB: Face, score: number) {
  return score <= FACE_MATCH_MAX_SCORE || isHighConfidenceMatch(faceA, faceB)
}

function matchScore(faceA: Face, faceB: Face) {
  const averageSize = Math.max(1, (faceA.width + faceA.height + faceB.width + faceB.height) / 4)
  const distanceScore = centerDistance(faceA, faceB) / averageSize
  const sizeScore = (
    Math.abs(faceA.width - faceB.width) / Math.max(1, Math.max(faceA.width, faceB.width))
    + Math.abs(faceA.height - faceB.height) / Math.max(1, Math.max(faceA.height, faceB.height))
  )

  return distanceScore + sizeScore
}

function matchFaces(previousFaces: Face[], nextFaces: Face[]) {
  const remainingPrevious = new Set(previousFaces.map((_, index) => index))
  const remainingNext = new Set(nextFaces.map((_, index) => index))
  const pairs: FacePair[] = []

  while (remainingPrevious.size > 0 && remainingNext.size > 0) {
    let bestPreviousIndex = -1
    let bestNextIndex = -1
    let bestScore = Number.POSITIVE_INFINITY

    for (const previousIndex of remainingPrevious) {
      for (const nextIndex of remainingNext) {
        const score = matchScore(previousFaces[previousIndex]!, nextFaces[nextIndex]!)

        if (score < bestScore) {
          bestScore = score
          bestPreviousIndex = previousIndex
          bestNextIndex = nextIndex
        }
      }
    }

    if (bestPreviousIndex < 0 || bestNextIndex < 0) {
      break
    }

    const previousFace = previousFaces[bestPreviousIndex]!
    const nextFace = nextFaces[bestNextIndex]!

    if (!canMatchFaces(previousFace, nextFace, bestScore)) {
      break
    }

    pairs.push({
      from: previousFace,
      to: nextFace
    })
    remainingPrevious.delete(bestPreviousIndex)
    remainingNext.delete(bestNextIndex)
  }

  for (const previousIndex of remainingPrevious) {
    pairs.push({
      from: previousFaces[previousIndex]
    })
  }

  for (const nextIndex of remainingNext) {
    pairs.push({
      to: nextFaces[nextIndex]
    })
  }

  return pairs
}

function findBestFace(targetFace: Face, faces: Face[], canUseFace: FaceMatcher) {
  let bestFace: Face | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const face of faces) {
    const score = matchScore(targetFace, face)

    if (score < bestScore && canUseFace(targetFace, face, score)) {
      bestScore = score
      bestFace = face
    }
  }

  return bestFace
}

function findMatchingFace(targetFace: Face, faces: Face[]) {
  return findBestFace(targetFace, faces, canMatchFaces)
}

function findAppearanceFace(targetFace: Face, faces: Face[]) {
  const exactMatch = findMatchingFace(targetFace, faces)

  if (exactMatch) {
    return exactMatch
  }

  return findBestFace(targetFace, faces, (faceA, faceB) => isHighConfidenceMatch(faceA, faceB))
}

function interpolateFace(faceA: Face, faceB: Face, t: number): Face {
  return {
    id: faceA.id,
    x: Math.round(lerp(faceA.x, faceB.x, t)),
    y: Math.round(lerp(faceA.y, faceB.y, t)),
    width: Math.round(lerp(faceA.width, faceB.width, t)),
    height: Math.round(lerp(faceA.height, faceB.height, t)),
    confidence: Number(Math.max(0, Math.min(1, lerp(faceA.confidence, faceB.confidence, t))).toFixed(4))
  }
}

function projectFaceFromPoints(
  points: FaceTrajectoryPoint[],
  frameIndex: number,
  fallbackFace: Face
) {
  if (points.length === 0) {
    return cloneFace(fallbackFace)
  }

  if (points.length === 1) {
    return cloneFace(points[0]!.face)
  }

  const orderedPoints = [...points].sort((left, right) => left.frameIndex - right.frameIndex)
  const firstPoint = orderedPoints[0]!
  const lastPoint = orderedPoints[orderedPoints.length - 1]!

  if (frameIndex <= firstPoint.frameIndex) {
    const nextPoint = orderedPoints[1]!
    const span = Math.max(1, nextPoint.frameIndex - firstPoint.frameIndex)
    return interpolateFace(firstPoint.face, nextPoint.face, (frameIndex - firstPoint.frameIndex) / span)
  }

  if (frameIndex >= lastPoint.frameIndex) {
    const previousPoint = orderedPoints[orderedPoints.length - 2]!
    const span = Math.max(1, lastPoint.frameIndex - previousPoint.frameIndex)
    return interpolateFace(previousPoint.face, lastPoint.face, (frameIndex - previousPoint.frameIndex) / span)
  }

  for (let index = 0; index < orderedPoints.length - 1; index += 1) {
    const leftPoint = orderedPoints[index]!
    const rightPoint = orderedPoints[index + 1]!

    if (frameIndex < leftPoint.frameIndex || frameIndex > rightPoint.frameIndex) {
      continue
    }

    const span = Math.max(1, rightPoint.frameIndex - leftPoint.frameIndex)
    return interpolateFace(leftPoint.face, rightPoint.face, (frameIndex - leftPoint.frameIndex) / span)
  }

  return cloneFace(fallbackFace)
}

function scaleFace(face: Face, scale: number): Face {
  const width = Math.round(face.width * scale)
  const height = Math.round(face.height * scale)

  return {
    ...face,
    x: Math.round(face.x - ((width - face.width) / 2)),
    y: Math.round(face.y - ((height - face.height) / 2)),
    width,
    height
  }
}

export function expandVideoBlurFaces(faces: Face[]) {
  return faces.map(face => scaleFace(face, VIDEO_BLUR_SCALE))
}

async function assignAppearanceFrames(
  targetFaces: Face[],
  startFrame: number,
  endFrame: number,
  detectFacesAtFrame: (frameIndex: number) => Promise<Face[]>,
  resolvedFrames: Map<Face, number>
) {
  if (targetFaces.length === 0) {
    return
  }

  if (endFrame - startFrame <= 1) {
    for (const face of targetFaces) {
      resolvedFrames.set(face, endFrame)
    }

    return
  }

  const probeFrame = startFrame + Math.max(1, Math.floor((endFrame - startFrame) / 2))
  const faces = await detectFacesAtFrame(probeFrame)
  const appearedFaces: Face[] = []
  const missingFaces: Face[] = []

  for (const targetFace of targetFaces) {
    if (findAppearanceFace(targetFace, faces)) {
      appearedFaces.push(targetFace)
      continue
    }

    missingFaces.push(targetFace)
  }

  await assignAppearanceFrames(appearedFaces, startFrame, probeFrame, detectFacesAtFrame, resolvedFrames)
  await assignAppearanceFrames(missingFaces, probeFrame, endFrame, detectFacesAtFrame, resolvedFrames)
}

export async function refineFaceSamples(
  samples: FaceSample[],
  detectFacesAtFrame: (frameIndex: number) => Promise<Face[]>,
  onProgress?: (completedIntervals: number, totalIntervals: number) => void
) {
  if (samples.length <= 1) {
    return samples
  }

  const orderedSamples = [...samples].sort((left, right) => left.frameIndex - right.frameIndex)
  const sampleMap = new Map<number, Face[]>(orderedSamples.map(sample => [sample.frameIndex, sample.faces]))
  const detectionCache = new Map<number, Face[]>(orderedSamples.map(sample => [sample.frameIndex, sample.faces]))
  const totalIntervals = Math.max(1, orderedSamples.length - 1)

  async function getFaces(frameIndex: number) {
    const cached = detectionCache.get(frameIndex)

    if (cached) {
      return cached
    }

    const faces = await detectFacesAtFrame(frameIndex)
    detectionCache.set(frameIndex, faces)

    if (faces.some(face => face.confidence >= HIGH_CONFIDENCE_FACE) && !sampleMap.has(frameIndex)) {
      sampleMap.set(frameIndex, faces)
    }

    return faces
  }

  for (let index = 0; index < orderedSamples.length - 1; index += 1) {
    const previousSample = orderedSamples[index]!
    const nextSample = orderedSamples[index + 1]!
    const pairs = matchFaces(previousSample.faces, nextSample.faces)
    const newFaces = pairs
      .filter(pair => !pair.from && pair.to)
      .map(pair => pair.to!)
    const appearanceFrames = new Map<Face, number>()

    await assignAppearanceFrames(
      newFaces,
      previousSample.frameIndex,
      nextSample.frameIndex,
      getFaces,
      appearanceFrames
    )

    for (const appearanceFrame of appearanceFrames.values()) {
      if (sampleMap.has(appearanceFrame)) {
        continue
      }

      sampleMap.set(appearanceFrame, await getFaces(appearanceFrame))
    }

    onProgress?.(index + 1, totalIntervals)
  }

  return [...sampleMap.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([frameIndex, faces]) => ({ frameIndex, faces }))
}

function collectTrajectoryPoints(
  samples: FaceSample[],
  startSampleIndex: number,
  startFace: Face,
  direction: 'backward' | 'forward',
  trajectoryWindowFrames: number
) {
  const originFrame = samples[startSampleIndex]!.frameIndex
  const points: FaceTrajectoryPoint[] = [{
    frameIndex: originFrame,
    face: startFace
  }]

  if (trajectoryWindowFrames <= 0) {
    return points
  }

  let currentFace = startFace

  if (direction === 'forward') {
    for (let index = startSampleIndex + 1; index < samples.length; index += 1) {
      const sample = samples[index]!

      if (sample.frameIndex - originFrame > trajectoryWindowFrames) {
        break
      }

      const match = findMatchingFace(currentFace, sample.faces)

      if (!match) {
        break
      }

      points.push({
        frameIndex: sample.frameIndex,
        face: match
      })
      currentFace = match
    }

    return points
  }

  for (let index = startSampleIndex - 1; index >= 0; index -= 1) {
    const sample = samples[index]!

    if (originFrame - sample.frameIndex > trajectoryWindowFrames) {
      break
    }

    const match = findMatchingFace(currentFace, sample.faces)

    if (!match) {
      break
    }

    points.unshift({
      frameIndex: sample.frameIndex,
      face: match
    })
    currentFace = match
  }

  return points
}

function createAppearanceExtension(
  appearanceFace: Face,
  appearanceSampleIndex: number,
  previousFrame: number,
  samples: FaceSample[],
  lookbackFrames: number,
  trajectoryWindowFrames: number
) {
  if (lookbackFrames <= 0) {
    return null
  }

  const appearanceFrame = samples[appearanceSampleIndex]!.frameIndex
  const startFrame = Math.max(previousFrame + 1, appearanceFrame - lookbackFrames)

  if (startFrame >= appearanceFrame) {
    return null
  }

  const trajectory = collectTrajectoryPoints(
    samples,
    appearanceSampleIndex,
    appearanceFace,
    'forward',
    trajectoryWindowFrames
  )

  return {
    startFrame,
    trajectory
  }
}

function createDisappearanceExtension(
  disappearingFace: Face,
  disappearanceSampleIndex: number,
  nextFrame: number,
  samples: FaceSample[],
  lookaheadFrames: number,
  trajectoryWindowFrames: number
) {
  if (lookaheadFrames <= 0) {
    return null
  }

  const disappearanceFrame = samples[disappearanceSampleIndex]!.frameIndex
  const endFrame = Math.min(nextFrame - 1, disappearanceFrame + lookaheadFrames)

  if (endFrame <= disappearanceFrame) {
    return null
  }

  const trajectory = collectTrajectoryPoints(
    samples,
    disappearanceSampleIndex,
    disappearingFace,
    'backward',
    trajectoryWindowFrames
  )

  return {
    endFrame,
    trajectory
  }
}

export function createFaceResolver(samples: FaceSample[], options: FaceResolverOptions = {}) {
  if (samples.length === 0) {
    return () => [] as Face[]
  }

  const normalizedSamples = [...samples].sort((left, right) => left.frameIndex - right.frameIndex)
  const segments: FaceSegment[] = []
  const appearanceLookbackFrames = Math.max(0, options.appearanceLookbackFrames ?? 0)
  const disappearanceLookaheadFrames = Math.max(0, options.disappearanceLookaheadFrames ?? 0)
  const trajectoryWindowFrames = Math.max(0, options.trajectoryWindowFrames ?? 0)

  for (let index = 0; index < normalizedSamples.length - 1; index += 1) {
    const currentSample = normalizedSamples[index]!
    const nextSample = normalizedSamples[index + 1]!
    const pairs = matchFaces(currentSample.faces, nextSample.faces).map((pair) => {
      if (!pair.from && pair.to) {
        return {
          ...pair,
          appearanceExtension: createAppearanceExtension(
            pair.to,
            index + 1,
            currentSample.frameIndex,
            normalizedSamples,
            appearanceLookbackFrames,
            trajectoryWindowFrames
          ),
          disappearanceExtension: null
        }
      }

      if (pair.from && !pair.to) {
        return {
          ...pair,
          appearanceExtension: null,
          disappearanceExtension: createDisappearanceExtension(
            pair.from,
            index,
            nextSample.frameIndex,
            normalizedSamples,
            disappearanceLookaheadFrames,
            trajectoryWindowFrames
          )
        }
      }

      return {
        ...pair,
        appearanceExtension: null,
        disappearanceExtension: null
      }
    })

    segments.push({
      startFrame: currentSample.frameIndex,
      endFrame: nextSample.frameIndex,
      pairs
    })
  }

  return (frameIndex: number) => {
    const firstSample = normalizedSamples[0]!
    const lastSample = normalizedSamples[normalizedSamples.length - 1]!

    if (frameIndex <= firstSample.frameIndex) {
      return firstSample.faces.map(cloneFace)
    }

    if (frameIndex >= lastSample.frameIndex) {
      return lastSample.faces.map(cloneFace)
    }

    const segment = segments.find(candidate => (
      frameIndex >= candidate.startFrame && frameIndex <= candidate.endFrame
    ))

    if (!segment) {
      return lastSample.faces.map(cloneFace)
    }

    const span = Math.max(1, segment.endFrame - segment.startFrame)
    const t = (frameIndex - segment.startFrame) / span

    return segment.pairs.flatMap((pair) => {
      if (pair.from && pair.to) {
        return [interpolateFace(pair.from, pair.to, t)]
      }

      if (
        pair.from
        && pair.disappearanceExtension
        && frameIndex >= segment.startFrame
        && frameIndex <= pair.disappearanceExtension.endFrame
      ) {
        return [
          projectFaceFromPoints(
            pair.disappearanceExtension.trajectory,
            frameIndex,
            pair.from
          )
        ]
      }

      if (
        pair.to
        && pair.appearanceExtension
        && frameIndex >= pair.appearanceExtension.startFrame
        && frameIndex < segment.endFrame
      ) {
        return [
          projectFaceFromPoints(
            pair.appearanceExtension.trajectory,
            frameIndex,
            pair.to
          )
        ]
      }

      if (pair.to && frameIndex >= segment.endFrame) {
        return [cloneFace(pair.to)]
      }

      return []
    })
  }
}
