import type { Face } from '../types/faces'

const MIN_BLUR_RADIUS = 2
const MAX_BLUR_RADIUS = 22
const MAX_BOOSTED_BLUR_RADIUS = MAX_BLUR_RADIUS * 2

interface RasterImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

interface BlurScratch {
  temporary: Uint8ClampedArray
  target: Uint8ClampedArray
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function getPixelIndex(x: number, y: number, width: number) {
  return (y * width + x) * 4
}

function readByte(data: Uint8ClampedArray, index: number) {
  return data[index] ?? 0
}

function ensureBuffer(buffer: Uint8ClampedArray, length: number) {
  return buffer.length >= length ? buffer : new Uint8ClampedArray(length)
}

function ensureScratch(scratch: BlurScratch, length: number) {
  scratch.temporary = ensureBuffer(scratch.temporary, length)
  scratch.target = ensureBuffer(scratch.target, length)
}

function createMaskChecker(face: Face) {
  const centerX = face.x + (face.width / 2)
  const centerY = face.y + (face.height / 2)
  const radiusX = Math.max(1, face.width / 2)
  const radiusY = Math.max(1, face.height / 2)

  return (x: number, y: number) => {
    const dx = (x + 0.5 - centerX) / radiusX
    const dy = (y + 0.5 - centerY) / radiusY

    return (dx * dx) + (dy * dy) <= 1
  }
}

function extractRegion(image: RasterImage, face: Face, padding: number) {
  const left = clamp(Math.floor(face.x - padding), 0, image.width - 1)
  const top = clamp(Math.floor(face.y - padding), 0, image.height - 1)
  const right = clamp(Math.ceil(face.x + face.width + padding), 0, image.width)
  const bottom = clamp(Math.ceil(face.y + face.height + padding), 0, image.height)
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  const data = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = getPixelIndex(left + x, top + y, image.width)
      const targetIndex = getPixelIndex(x, y, width)

      data[targetIndex] = readByte(image.data, sourceIndex)
      data[targetIndex + 1] = readByte(image.data, sourceIndex + 1)
      data[targetIndex + 2] = readByte(image.data, sourceIndex + 2)
      data[targetIndex + 3] = readByte(image.data, sourceIndex + 3)
    }
  }

  return { left, top, width, height, data }
}

function averageBlock(data: Uint8ClampedArray, width: number, startX: number, startY: number, endX: number, endY: number): [number, number, number, number] {
  let red = 0
  let green = 0
  let blue = 0
  let alpha = 0
  let count = 0

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = getPixelIndex(x, y, width)
      red += readByte(data, index)
      green += readByte(data, index + 1)
      blue += readByte(data, index + 2)
      alpha += readByte(data, index + 3)
      count += 1
    }
  }

  return [
    Math.round(red / count),
    Math.round(green / count),
    Math.round(blue / count),
    Math.round(alpha / count)
  ]
}

function pixelateRegion(region: RasterImage, blockSize: number, scratch: BlurScratch) {
  ensureScratch(scratch, region.data.length)
  const output = scratch.target
  output.set(region.data)

  for (let y = 0; y < region.height; y += blockSize) {
    for (let x = 0; x < region.width; x += blockSize) {
      const endX = Math.min(region.width, x + blockSize)
      const endY = Math.min(region.height, y + blockSize)
      const [red, green, blue, alpha] = averageBlock(region.data, region.width, x, y, endX, endY)

      for (let fillY = y; fillY < endY; fillY += 1) {
        for (let fillX = x; fillX < endX; fillX += 1) {
          const index = getPixelIndex(fillX, fillY, region.width)
          output[index] = red
          output[index + 1] = green
          output[index + 2] = blue
          output[index + 3] = alpha
        }
      }
    }
  }

  return output
}

function boxBlurHorizontal(input: Uint8ClampedArray, output: Uint8ClampedArray, width: number, height: number, radius: number) {
  const windowSize = (radius * 2) + 1

  for (let y = 0; y < height; y += 1) {
    let red = 0
    let green = 0
    let blue = 0
    let alpha = 0

    for (let offset = -radius; offset <= radius; offset += 1) {
      const sampleX = clamp(offset, 0, width - 1)
      const sampleIndex = getPixelIndex(sampleX, y, width)
      red += readByte(input, sampleIndex)
      green += readByte(input, sampleIndex + 1)
      blue += readByte(input, sampleIndex + 2)
      alpha += readByte(input, sampleIndex + 3)
    }

    for (let x = 0; x < width; x += 1) {
      const index = getPixelIndex(x, y, width)
      output[index] = Math.round(red / windowSize)
      output[index + 1] = Math.round(green / windowSize)
      output[index + 2] = Math.round(blue / windowSize)
      output[index + 3] = Math.round(alpha / windowSize)

      const removeX = clamp(x - radius, 0, width - 1)
      const addX = clamp(x + radius + 1, 0, width - 1)
      const removeIndex = getPixelIndex(removeX, y, width)
      const addIndex = getPixelIndex(addX, y, width)

      red += readByte(input, addIndex) - readByte(input, removeIndex)
      green += readByte(input, addIndex + 1) - readByte(input, removeIndex + 1)
      blue += readByte(input, addIndex + 2) - readByte(input, removeIndex + 2)
      alpha += readByte(input, addIndex + 3) - readByte(input, removeIndex + 3)
    }
  }
}

function boxBlurVertical(input: Uint8ClampedArray, output: Uint8ClampedArray, width: number, height: number, radius: number) {
  const windowSize = (radius * 2) + 1

  for (let x = 0; x < width; x += 1) {
    let red = 0
    let green = 0
    let blue = 0
    let alpha = 0

    for (let offset = -radius; offset <= radius; offset += 1) {
      const sampleY = clamp(offset, 0, height - 1)
      const sampleIndex = getPixelIndex(x, sampleY, width)
      red += readByte(input, sampleIndex)
      green += readByte(input, sampleIndex + 1)
      blue += readByte(input, sampleIndex + 2)
      alpha += readByte(input, sampleIndex + 3)
    }

    for (let y = 0; y < height; y += 1) {
      const index = getPixelIndex(x, y, width)
      output[index] = Math.round(red / windowSize)
      output[index + 1] = Math.round(green / windowSize)
      output[index + 2] = Math.round(blue / windowSize)
      output[index + 3] = Math.round(alpha / windowSize)

      const removeY = clamp(y - radius, 0, height - 1)
      const addY = clamp(y + radius + 1, 0, height - 1)
      const removeIndex = getPixelIndex(x, removeY, width)
      const addIndex = getPixelIndex(x, addY, width)

      red += readByte(input, addIndex) - readByte(input, removeIndex)
      green += readByte(input, addIndex + 1) - readByte(input, removeIndex + 1)
      blue += readByte(input, addIndex + 2) - readByte(input, removeIndex + 2)
      alpha += readByte(input, addIndex + 3) - readByte(input, removeIndex + 3)
    }
  }
}

function gaussianApproximation(region: RasterImage, radius: number, scratch: BlurScratch) {
  if (radius <= 1) {
    return new Uint8ClampedArray(region.data)
  }

  ensureScratch(scratch, region.data.length)

  for (let pass = 0; pass < 3; pass += 1) {
    const source = pass === 0 ? region.data : scratch.target
    boxBlurHorizontal(source, scratch.temporary, region.width, region.height, radius)
    boxBlurVertical(scratch.temporary, scratch.target, region.width, region.height, radius)
  }

  return scratch.target
}

function resolveBlurRadius(blurIntensity: number) {
  const sliderIntensity = Number.isFinite(blurIntensity) ? clamp(blurIntensity, 0, 1) : 0.5
  const effectiveIntensity = sliderIntensity <= 0.5
    ? 0.5 + sliderIntensity
    : sliderIntensity * 2

  if (effectiveIntensity > 1) {
    return Math.round(MAX_BLUR_RADIUS + ((effectiveIntensity - 1) * (MAX_BOOSTED_BLUR_RADIUS - MAX_BLUR_RADIUS)))
  }

  return Math.round(MIN_BLUR_RADIUS + (effectiveIntensity * (MAX_BLUR_RADIUS - MIN_BLUR_RADIUS)))
}

function blurRegion(region: RasterImage, radius: number, scratch: BlurScratch) {
  if (Math.min(region.width, region.height) < radius) {
    return pixelateRegion(region, Math.max(4, radius), scratch)
  }

  return gaussianApproximation(region, radius, scratch)
}

export function applyBlurEffects(
  image: RasterImage,
  faces: Face[],
  excludedFaceIds: string[] = [],
  blurIntensity = 0.5
) {
  const output = new Uint8ClampedArray(image.data)
  const excludedFaces = new Set(excludedFaceIds)
  const blurRadius = resolveBlurRadius(blurIntensity)
  const scratch: BlurScratch = {
    temporary: new Uint8ClampedArray(0),
    target: new Uint8ClampedArray(0)
  }

  for (const face of faces) {
    if (excludedFaces.has(face.id)) {
      continue
    }

    const padding = Math.max(6, Math.round(Math.min(face.width, face.height) * 0.12))
    const region = extractRegion(image, face, padding)
    const blurred = blurRegion(region, blurRadius, scratch)
    const isInsideFace = createMaskChecker(face)

    for (let y = 0; y < region.height; y += 1) {
      for (let x = 0; x < region.width; x += 1) {
        const globalX = region.left + x
        const globalY = region.top + y

        if (!isInsideFace(globalX, globalY)) {
          continue
        }

        const targetIndex = getPixelIndex(globalX, globalY, image.width)
        const sourceIndex = getPixelIndex(x, y, region.width)
        output[targetIndex] = readByte(blurred, sourceIndex)
        output[targetIndex + 1] = readByte(blurred, sourceIndex + 1)
        output[targetIndex + 2] = readByte(blurred, sourceIndex + 2)
        output[targetIndex + 3] = readByte(blurred, sourceIndex + 3)
      }
    }
  }

  return output
}
