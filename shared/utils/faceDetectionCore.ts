import type { DetectionInput, Face } from '../types/faces'
import { hardNonMaxSuppression } from './nms'

export const MODEL_WIDTH = 640
export const MODEL_HEIGHT = 480
export const DEFAULT_PROBABILITY_THRESHOLD = 0.5

const MODEL_MEAN = 127
const MODEL_SCALE = 128
const IOU_THRESHOLD = 0.3

interface TensorOutput {
  data: unknown
  dims?: readonly number[]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function readByte(data: Uint8ClampedArray, index: number) {
  return data[index] ?? 0
}

function readFloat(data: Float32Array, index: number) {
  return data[index] ?? 0
}

export function createModelInputData(
  input: DetectionInput,
  width = MODEL_WIDTH,
  height = MODEL_HEIGHT
) {
  const output = new Float32Array(3 * width * height)
  const { data, width: sourceWidth, height: sourceHeight } = input

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.round((y / height) * sourceHeight))

    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.round((x / width) * sourceWidth))
      const sourceIndex = (sourceY * sourceWidth + sourceX) * 4
      const targetIndex = y * width + x

      output[targetIndex] = (readByte(data, sourceIndex) - MODEL_MEAN) / MODEL_SCALE
      output[(width * height) + targetIndex] = (readByte(data, sourceIndex + 1) - MODEL_MEAN) / MODEL_SCALE
      output[(width * height * 2) + targetIndex] = (readByte(data, sourceIndex + 2) - MODEL_MEAN) / MODEL_SCALE
    }
  }

  return output
}

function pickDetections(
  confidences: Float32Array,
  boxes: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  probabilityThreshold: number
) {
  const classCount = 2
  const boxCount = boxes.length / 4
  const candidates: Array<{ x1: number, y1: number, x2: number, y2: number, score: number }> = []

  for (let index = 0; index < boxCount; index += 1) {
    const faceConfidence = readFloat(confidences, (index * classCount) + 1)

    if (faceConfidence < probabilityThreshold) {
      continue
    }

    const x1 = clamp(readFloat(boxes, index * 4) * sourceWidth, 0, sourceWidth)
    const y1 = clamp(readFloat(boxes, (index * 4) + 1) * sourceHeight, 0, sourceHeight)
    const x2 = clamp(readFloat(boxes, (index * 4) + 2) * sourceWidth, 0, sourceWidth)
    const y2 = clamp(readFloat(boxes, (index * 4) + 3) * sourceHeight, 0, sourceHeight)

    candidates.push({
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
      score: faceConfidence
    })
  }

  return hardNonMaxSuppression(candidates, IOU_THRESHOLD)
}

function mapFaces(candidates: ReturnType<typeof hardNonMaxSuppression>): Face[] {
  return candidates.map((candidate, index) => ({
    id: `face-${index + 1}`,
    x: Math.round(candidate.x1),
    y: Math.round(candidate.y1),
    width: Math.round(candidate.x2 - candidate.x1),
    height: Math.round(candidate.y2 - candidate.y1),
    confidence: Number(candidate.score.toFixed(4))
  }))
}

export function resolveOutputTensors(
  outputs: Record<string, TensorOutput>,
  outputNames: readonly string[]
) {
  const [firstName, secondName] = outputNames

  if (!firstName || !secondName) {
    throw new Error('Le modele de detection de visages a renvoye des sorties inattendues.')
  }

  const first = outputs[firstName]
  const second = outputs[secondName]

  if (!first || !second) {
    throw new Error('Le modele de detection de visages a renvoye des sorties inattendues.')
  }

  return first.dims?.[first.dims.length - 1] === 4
    ? { boxTensor: first, confidenceTensor: second }
    : { boxTensor: second, confidenceTensor: first }
}

export function extractFacesFromOutputs(
  boxes: Float32Array,
  confidences: Float32Array,
  input: DetectionInput,
  probabilityThreshold: number
) {
  return mapFaces(
    pickDetections(
      confidences,
      boxes,
      input.width,
      input.height,
      probabilityThreshold
    )
  )
}
