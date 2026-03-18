import sharp from 'sharp'
import type { DetectionInput, ProcessImagePayload } from '~~/shared/types/faces'
import { applyBlurEffects } from '~~/shared/utils/imageProcessing'
import { useFaceDetector } from '~~/shared/utils/useFaceDetector'

const SERVER_MODEL_PATH = `${process.cwd()}/public/models/version-RFB-640.onnx`
const detector = useFaceDetector(SERVER_MODEL_PATH)

async function decodeImage(imageBase64: string): Promise<DetectionInput> {
  const inputBuffer = Buffer.from(imageBase64, 'base64')
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  return {
    data: new Uint8ClampedArray(data),
    width: info.width,
    height: info.height
  }
}

async function detectFaces(payload: ProcessImagePayload) {
  const image = await decodeImage(payload.imageBase64)
  return await detector.detectFaces(image, payload.settings.confidenceThreshold)
}

async function blurImage(payload: ProcessImagePayload) {
  const image = await decodeImage(payload.imageBase64)
  const result = await detector.detectFaces(image, payload.settings.confidenceThreshold)
  const allFaces = [...result.faces, ...(payload.manualFaces || [])]

  return await sharp(
    Buffer.from(applyBlurEffects(image, allFaces, payload.settings.excludedFaceIds)),
    {
      raw: {
        width: image.width,
        height: image.height,
        channels: 4
      }
    }
  ).png().toBuffer()
}

export default defineEventHandler(async (event) => {
  const payload = await readBody<ProcessImagePayload & { action?: 'detect' | 'process' }>(event)

  if (!payload?.imageBase64 || !payload?.settings) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Une image encodee en base64 et des reglages sont requis.'
    })
  }

  if (payload.action === 'detect') {
    return await detectFaces(payload)
  }

  const output = await blurImage(payload)
  setHeader(event, 'content-type', 'image/png')
  setHeader(event, 'cache-control', 'no-store')
  return output
})
