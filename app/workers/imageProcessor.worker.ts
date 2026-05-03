/// <reference lib="webworker" />

import type { EditorSettings, Face } from '~~/shared/types/faces'
import { applyBlurEffects } from '~~/shared/utils/imageProcessing'
import { useFaceDetector } from '~~/shared/utils/useFaceDetector'

interface DetectRequest {
  type: 'detect'
  imageData: ImageData
  threshold: number
  modelUrl: string
}

interface ProcessRequest {
  type: 'process'
  imageData: ImageData
  settings: EditorSettings
  manualFaces?: Face[]
  modelUrl: string
}

type WorkerRequest = DetectRequest | ProcessRequest

const messageContext: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope

async function detectFaces(imageData: ImageData, threshold: number, modelUrl: string): Promise<{ faces: Face[], durationMs: number }> {
  const detector = useFaceDetector(modelUrl)
  return await detector.detectFaces({
    data: imageData.data,
    width: imageData.width,
    height: imageData.height
  }, threshold)
}

async function processImage(imageData: ImageData, settings: EditorSettings, modelUrl: string, manualFaces: Face[] = []) {
  const { faces, durationMs } = await detectFaces(imageData, settings.confidenceThreshold, modelUrl)
  const allFaces = [...faces, ...manualFaces]
  const processedImageData = new ImageData(
    applyBlurEffects(
      { data: imageData.data, width: imageData.width, height: imageData.height },
      allFaces,
      settings.excludedFaceIds,
      settings.blurIntensity
    ),
    imageData.width,
    imageData.height
  )

  return {
    faces: allFaces,
    processedImageData,
    durationMs
  }
}

messageContext.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'detect') {
      const result = await detectFaces(event.data.imageData, event.data.threshold, event.data.modelUrl)
      messageContext.postMessage({
        type: 'detect:success',
        ...result
      })
      return
    }

    const result = await processImage(
      event.data.imageData,
      event.data.settings,
      event.data.modelUrl,
      event.data.manualFaces
    )
    messageContext.postMessage({
      type: 'process:success',
      ...result
    })
  } catch (error) {
    messageContext.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'La requete du worker a echoue.'
    })
  }
}
