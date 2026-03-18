import type { FFmpeg as BrowserFFmpeg } from '@ffmpeg/ffmpeg'
import classWorkerURL from '@ffmpeg/ffmpeg/worker?url'
import type { EditorSettings } from '~~/shared/types/faces'
import {
  blurVideoFrame,
  collectFaceSamples,
  createVideoFaceResolver,
  getDetectionIntervalFrames,
  getFrameProcessingProgress,
  VIDEO_PROGRESS_REFINEMENT_END,
  VIDEO_PROGRESS_FRAME_END
} from '~~/shared/utils/videoProcessing'
import { useFaceDetector } from '~~/shared/utils/useFaceDetector'
import { imageDataToDetectionInput } from '~/utils/image-io'

const MODEL_URL = '/models/version-RFB-640.onnx'
const FFMPEG_CORE_VERSION = '0.12.10'
const FFMPEG_LOAD_TIMEOUT_MS = 30_000
const DEBUG_PREFIX = '[solifloute:browser-video]'

interface VideoWithCaptureStream extends HTMLVideoElement {
  captureStream?: () => MediaStream
}

let ffmpegPromise: Promise<{
  ffmpeg: BrowserFFmpeg
  fetchFile: (file: File) => Promise<Uint8Array>
}> | null = null

function debugLog(message: string, details?: unknown) {
  if (details === undefined) {
    console.info(`${DEBUG_PREFIX} ${message}`)
    return
  }

  console.info(`${DEBUG_PREFIX} ${message}`, details)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)

    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function getBrowserFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      debugLog('loading ffmpeg modules')
      const [{ FFmpeg }, { toBlobURL, fetchFile }] = await Promise.all([
        import('@ffmpeg/ffmpeg'),
        import('@ffmpeg/util')
      ])
      const ffmpeg = new FFmpeg()
      const coreBaseUrl = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`
      debugLog('loading ffmpeg core', { classWorkerURL, coreBaseUrl })

      const [coreURL, wasmURL] = await withTimeout(
        Promise.all([
          toBlobURL(`${coreBaseUrl}/ffmpeg-core.js`, 'text/javascript'),
          toBlobURL(`${coreBaseUrl}/ffmpeg-core.wasm`, 'application/wasm')
        ]),
        FFMPEG_LOAD_TIMEOUT_MS,
        'Le telechargement des assets FFmpeg du navigateur a expire. Verifiez l acces reseau au CDN ou utilisez le mode serveur.'
      )
      debugLog('ffmpeg runtime assets ready')

      await withTimeout(
        ffmpeg.load({
          classWorkerURL,
          coreURL,
          wasmURL
        }),
        FFMPEG_LOAD_TIMEOUT_MS,
        'Le runtime FFmpeg du navigateur ne repond pas. Verifiez l acces reseau au CDN ou utilisez le mode serveur.'
      )
      debugLog('ffmpeg core ready')

      return { ffmpeg, fetchFile }
    })().catch((error) => {
      console.error(`${DEBUG_PREFIX} ffmpeg bootstrap failed`, error)
      ffmpegPromise = null
      throw error
    })
  }

  return await ffmpegPromise
}

async function waitForVideoMetadata(video: HTMLVideoElement) {
  if (video.readyState >= 1) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('Impossible de lire la video selectionnee.'))
  })
}

async function seekVideo(video: HTMLVideoElement, time: number) {
  await new Promise<void>((resolve, reject) => {
    const handleSeeked = () => {
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('error', handleError)
      resolve()
    }

    const handleError = () => {
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('error', handleError)
      reject(new Error('Impossible de decoder une image de la video.'))
    }

    video.addEventListener('seeked', handleSeeked)
    video.addEventListener('error', handleError)
    video.currentTime = time
  })
}

async function canvasToPngBytes(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (!nextBlob) {
        reject(new Error('Impossible d encoder une image de la video.'))
        return
      }

      resolve(nextBlob)
    }, 'image/png')
  })

  return new Uint8Array(await blob.arrayBuffer())
}

function getVideoFps(video: HTMLVideoElement) {
  const element = video as VideoWithCaptureStream
  const stream = typeof element.captureStream === 'function' ? element.captureStream() : null
  const fps = stream?.getVideoTracks()?.[0]?.getSettings()?.frameRate || 24

  stream?.getTracks().forEach(track => track.stop())

  return Math.max(1, Math.round(fps))
}

function normalizeErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

export async function processVideoInBrowser(
  file: File,
  settings: EditorSettings,
  onProgress?: (progress: number) => void
) {
  debugLog('starting browser video processing', {
    fileName: file.name,
    fileSize: file.size,
    detectionIntervalSeconds: settings.detectionIntervalSeconds
  })
  onProgress?.(0.01)
  const { ffmpeg, fetchFile } = await getBrowserFFmpeg()
  const detector = useFaceDetector(MODEL_URL)
  const sourceUrl = URL.createObjectURL(file)
  const video = document.createElement('video')
  const sourceCanvas = document.createElement('canvas')
  const outputCanvas = document.createElement('canvas')
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
  const outputContext = outputCanvas.getContext('2d')

  if (!sourceContext || !outputContext) {
    URL.revokeObjectURL(sourceUrl)
    throw new Error('Le contexte canvas 2D est indisponible.')
  }

  const drawContext = sourceContext
  const previewContext = outputContext

  video.src = sourceUrl
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true

  try {
    debugLog('waiting for video metadata')
    await waitForVideoMetadata(video)
    onProgress?.(0.03)

    sourceCanvas.width = video.videoWidth
    sourceCanvas.height = video.videoHeight
    outputCanvas.width = video.videoWidth
    outputCanvas.height = video.videoHeight

    const fps = getVideoFps(video)
    const frameDuration = 1 / fps
    const maxTime = Math.max(0, video.duration - 0.001)
    const frameCount = Math.max(1, Math.ceil(video.duration * fps))
    const detectionIntervalFrames = getDetectionIntervalFrames(fps, settings)
    const jobId = crypto.randomUUID().replaceAll('-', '')
    const inputName = `${jobId}-input.${file.name.split('.').pop() || 'mp4'}`
    const outputName = `${jobId}-output.mp4`
    debugLog('video metadata ready', {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
      fps,
      frameCount,
      detectionIntervalFrames
    })

    async function readFrame(frameIndex: number) {
      const currentTime = Math.min(maxTime, frameIndex * frameDuration)

      await seekVideo(video, currentTime)
      drawContext.drawImage(video, 0, 0, sourceCanvas.width, sourceCanvas.height)
      return drawContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height)
    }

    async function detectFacesAtFrame(frameIndex: number) {
      const imageData = await readFrame(frameIndex)
      const detection = await detector.detectFaces(
        imageDataToDetectionInput(imageData),
        settings.confidenceThreshold
      )

      return detection.faces
    }

    const samples = await collectFaceSamples(
      frameCount,
      detectionIntervalFrames,
      detectFacesAtFrame,
      onProgress
    )
    debugLog('face samples collected', { sampleCount: samples.length })
    const resolveFaces = createVideoFaceResolver(samples, fps)

    debugLog('writing input video to ffmpeg fs')
    await ffmpeg.writeFile(inputName, await fetchFile(file))
    onProgress?.(VIDEO_PROGRESS_REFINEMENT_END)

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      if (frameIndex === 0 || frameIndex % 30 === 0) {
        debugLog('processing frame batch', { frameIndex, frameCount })
      }
      const imageData = await readFrame(frameIndex)
      const processedImageData = new ImageData(
        blurVideoFrame(
          {
            data: imageData.data,
            width: imageData.width,
            height: imageData.height
          },
          settings,
          resolveFaces,
          frameIndex
        ),
        imageData.width,
        imageData.height
      )

      previewContext.putImageData(processedImageData, 0, 0)
      await ffmpeg.writeFile(
        `${jobId}-frame-${String(frameIndex + 1).padStart(5, '0')}.png`,
        await canvasToPngBytes(outputCanvas)
      )
      onProgress?.(getFrameProcessingProgress(frameIndex, frameCount))
    }

    debugLog('encoding output video')
    let lastLoggedEncodingBucket = -1
    const handleEncodingProgress = ({ progress, time }: { progress: number, time: number }) => {
      const normalized = Math.max(0, Math.min(1, progress))
      onProgress?.(VIDEO_PROGRESS_FRAME_END + (normalized * (1 - VIDEO_PROGRESS_FRAME_END)))
      const bucket = Math.floor(normalized * 20)

      if (bucket !== lastLoggedEncodingBucket || normalized >= 1) {
        lastLoggedEncodingBucket = bucket
        debugLog('ffmpeg encoding progress', {
          progress: normalized,
          encodedTimeSeconds: time / 1_000_000
        })
      }
    }
    const handleEncodingLog = ({ type, message }: { type: string, message: string }) => {
      if (
        type === 'fferr'
        || message.includes('frame=')
        || message.includes('time=')
        || message.includes('Error')
      ) {
        debugLog('ffmpeg log', { type, message })
      }
    }

    ffmpeg.on('progress', handleEncodingProgress)
    ffmpeg.on('log', handleEncodingLog)

    try {
      const exitCode = await ffmpeg.exec([
        '-framerate',
        `${fps}`,
        '-i',
        `${jobId}-frame-%05d.png`,
        '-i',
        inputName,
        '-map',
        '0:v:0',
        '-map',
        '1:a?',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        '-shortest',
        outputName
      ])

      debugLog('ffmpeg encoding finished', { exitCode })

      if (exitCode !== 0) {
        throw new Error(`L encodage video du navigateur a echoue (code ${exitCode}).`)
      }
    } catch (error) {
      throw new Error(`L encodage video du navigateur a echoue: ${normalizeErrorMessage(error)}`)
    } finally {
      ffmpeg.off('progress', handleEncodingProgress)
      ffmpeg.off('log', handleEncodingLog)
    }

    const data = await ffmpeg.readFile(outputName)

    if (!(data instanceof Uint8Array)) {
      throw new Error('L encodeur video du navigateur a renvoye un fichier invalide.')
    }

    debugLog('browser video processing completed', { bytes: data.byteLength })
    onProgress?.(1)
    return new Blob([data.slice()], { type: 'video/mp4' })
  } catch (error) {
    console.error(`${DEBUG_PREFIX} processing failed`, error)
    throw error
  } finally {
    video.removeAttribute('src')
    URL.revokeObjectURL(sourceUrl)
  }
}
