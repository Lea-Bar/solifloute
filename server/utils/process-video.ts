import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import type { EditorSettings } from '~~/shared/types/faces'
import {
  blurVideoFrame,
  createVideoFaceResolver,
  getDetectionIntervalFrames,
  getFrameProcessingProgress,
  refineCollectedFaceSamples,
  VIDEO_PROGRESS_DETECTION_END
} from '~~/shared/utils/videoProcessing'
import { useFaceDetector } from '~~/shared/utils/useFaceDetector'

const execFileAsync = promisify(execFile)
const SERVER_MODEL_PATH = `${process.cwd()}/public/models/version-RFB-640.onnx`
const VIDEO_OUTPUT_ROOT = process.env.PROCESS_VIDEO_OUTPUT_DIR || join(process.cwd(), '.data', 'video-results')
const detector = useFaceDetector(SERVER_MODEL_PATH)

interface VideoMetadata {
  width: number
  height: number
  fps: number
  frameCount: number
}

interface ProcessVideoResult {
  outputPath: string
  tempRoot: string
}

function createAbortError() {
  return new Error('Traitement video annule.')
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

function getFfmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

function getFfprobePath() {
  return process.env.FFPROBE_PATH || 'ffprobe'
}

function getInputExtension(fileName: string) {
  return extname(fileName).toLowerCase() || '.mp4'
}

function parseFrameRate(value: string) {
  const [numeratorText, denominatorText = '1'] = value.trim().split('/')
  const numerator = Number(numeratorText)
  const denominator = Number(denominatorText)

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 24
  }

  const fps = numerator / denominator
  return Number.isFinite(fps) && fps > 0 ? fps : 24
}

function captureTextStream(stream: NodeJS.ReadableStream | null) {
  let output = ''

  if (stream) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      output += chunk
    })
  }

  return () => output.trim()
}

function waitForProcess(child: ReturnType<typeof spawn>, fallbackMessage: string, readStderr: () => string, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const handleAbort = () => {
      child.kill('SIGKILL')
      reject(createAbortError())
    }

    signal?.addEventListener('abort', handleAbort, { once: true })

    child.once('error', reject)
    child.once('close', (code) => {
      signal?.removeEventListener('abort', handleAbort)

      if (signal?.aborted) {
        reject(createAbortError())
        return
      }

      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(readStderr() || fallbackMessage))
    })
  })
}

async function silenceProcess(
  child: ReturnType<typeof spawn>,
  done: Promise<void>,
  signal: NodeJS.Signals = 'SIGKILL'
) {
  child.kill(signal)
  await done.catch(() => {})
}

async function readVideoMetadata(inputPath: string, signal?: AbortSignal): Promise<VideoMetadata> {
  throwIfAborted(signal)
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,avg_frame_rate,nb_frames:format=duration',
    '-of',
    'json',
    inputPath
  ], { signal })
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ width?: number, height?: number, avg_frame_rate?: string, nb_frames?: string }>
    format?: { duration?: string }
  }
  const stream = parsed.streams?.[0]
  const width = stream?.width ?? 0
  const height = stream?.height ?? 0

  if (width <= 0 || height <= 0) {
    throw new Error('Dimensions video invalides.')
  }

  const fps = parseFrameRate(stream?.avg_frame_rate || '')
  const frameCountFromStream = Number(stream?.nb_frames || '0')
  const duration = Number(parsed.format?.duration || '0')
  const frameCount = frameCountFromStream > 0
    ? frameCountFromStream
    : Math.max(1, Math.ceil(duration * fps))

  return { width, height, fps, frameCount }
}

async function writeFrame(stdin: NodeJS.WritableStream, frame: Uint8ClampedArray, signal?: AbortSignal) {
  throwIfAborted(signal)
  const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)

  if (stdin.write(buffer)) {
    return
  }

  await once(stdin, 'drain')
  throwIfAborted(signal)
}

async function detectFacesFromPixels(
  pixels: Uint8ClampedArray,
  metadata: VideoMetadata,
  probabilityThreshold: number
) {
  const detection = await detector.detectFaces({
    data: pixels,
    width: metadata.width,
    height: metadata.height
  }, probabilityThreshold)

  return detection.faces
}

async function readFramePixels(inputPath: string, metadata: VideoMetadata, frameIndex: number, signal?: AbortSignal) {
  throwIfAborted(signal)
  const { stdout } = await execFileAsync(getFfmpegPath(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-vf',
    `select=eq(n\\,${frameIndex})`,
    '-vsync',
    '0',
    '-vframes',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    'pipe:1'
  ], {
    encoding: 'buffer',
    maxBuffer: Math.max(1024 * 1024, metadata.width * metadata.height * 4 * 2),
    signal
  })

  const frameBuffer = stdout instanceof Buffer ? stdout : Buffer.from(stdout)
  const expectedSize = metadata.width * metadata.height * 4

  if (frameBuffer.length < expectedSize) {
    throw new Error(`Impossible de lire la frame ${frameIndex} pour la redetection.`)
  }

  return new Uint8ClampedArray(frameBuffer.subarray(0, expectedSize))
}

async function detectSampledFaces(
  inputPath: string,
  metadata: VideoMetadata,
  settings: EditorSettings,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
) {
  throwIfAborted(signal)
  const frameSize = metadata.width * metadata.height * 4
  const detectionIntervalFrames = getDetectionIntervalFrames(metadata.fps, settings)
  const expectedSampleCount = Math.max(1, Math.ceil(metadata.frameCount / detectionIntervalFrames))
  const frameCache = new Map<number, Uint8ClampedArray>()
  const samples: Array<{ frameIndex: number, faces: Awaited<ReturnType<typeof detectFacesFromPixels>> }> = []
  const decoder = spawn(getFfmpegPath(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-vsync',
    '0',
    'pipe:1'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (!decoder.stdout) {
    throw new Error('Le flux de detection video est indisponible.')
  }

  const readDecoderError = captureTextStream(decoder.stderr)
  const decoderDone = waitForProcess(decoder, 'Le decodage video a echoue.', readDecoderError, signal)
  let remainder = Buffer.alloc(0)
  let frameIndex = 0

  async function detectFacesAtFrame(targetFrameIndex: number) {
    throwIfAborted(signal)
    const cachedPixels = frameCache.get(targetFrameIndex)
    const pixels = cachedPixels || await readFramePixels(inputPath, metadata, targetFrameIndex, signal)

    return await detectFacesFromPixels(pixels, metadata, settings.confidenceThreshold)
  }

  try {
    for await (const chunk of decoder.stdout) {
      throwIfAborted(signal)
      remainder = Buffer.concat([remainder, chunk as Buffer])

      while (remainder.length >= frameSize) {
        throwIfAborted(signal)
        const frameBuffer = remainder.subarray(0, frameSize)
        remainder = remainder.subarray(frameSize)
        const framePixels = new Uint8ClampedArray(frameBuffer)
        frameCache.set(frameIndex, framePixels)

        if (frameIndex === 0 || frameIndex % detectionIntervalFrames === 0) {
          samples.push({
            frameIndex,
            faces: await detectFacesFromPixels(framePixels, metadata, settings.confidenceThreshold)
          })
          onProgress?.((samples.length / expectedSampleCount) * VIDEO_PROGRESS_DETECTION_END)
        }

        if (frameCache.size > 2) {
          frameCache.delete(frameIndex - 2)
        }

        frameIndex += 1
      }
    }

    if (remainder.length > 0) {
      throw new Error('Le flux video brut est incomplet.')
    }

    await decoderDone

    return await refineCollectedFaceSamples(
      samples,
      metadata.frameCount,
      detectFacesAtFrame,
      onProgress
    )
  } catch (cause) {
    await silenceProcess(decoder, decoderDone)
    throw cause
  }
}

export async function processVideoToFile(
  inputBuffer: Buffer,
  fileName: string,
  settings: EditorSettings,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
): Promise<ProcessVideoResult> {
  throwIfAborted(signal)
  await mkdir(VIDEO_OUTPUT_ROOT, { recursive: true })
  const tempRoot = await mkdtemp(join(VIDEO_OUTPUT_ROOT, 'job-'))
  const inputPath = join(tempRoot, `input${getInputExtension(fileName)}`)
  const outputPath = join(tempRoot, 'output.mp4')

  try {
    throwIfAborted(signal)
    await writeFile(inputPath, inputBuffer)
    const metadata = await readVideoMetadata(inputPath, signal)
    const frameSize = metadata.width * metadata.height * 4
    const samples = await detectSampledFaces(inputPath, metadata, settings, onProgress, signal)
    throwIfAborted(signal)
    const resolveFaces = createVideoFaceResolver(samples, metadata.fps)
    const decoder = spawn(getFfmpegPath(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-vsync',
      '0',
      'pipe:1'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const encoder = spawn(getFfmpegPath(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${metadata.width}x${metadata.height}`,
      '-r',
      `${metadata.fps}`,
      '-i',
      'pipe:0',
      '-i',
      inputPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a?',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      outputPath
    ], {
      stdio: ['pipe', 'ignore', 'pipe']
    })

    if (!decoder.stdout || !encoder.stdin) {
      throw new Error('Les flux video serveur sont indisponibles.')
    }

    const readDecoderError = captureTextStream(decoder.stderr)
    const readEncoderError = captureTextStream(encoder.stderr)
    const decoderDone = waitForProcess(decoder, 'Le decodage video a echoue.', readDecoderError, signal)
    const encoderDone = waitForProcess(encoder, 'L encodage video a echoue.', readEncoderError, signal)
    let frameIndex = 0
    let remainder = Buffer.alloc(0)

    try {
      for await (const chunk of decoder.stdout) {
        throwIfAborted(signal)
        remainder = Buffer.concat([remainder, chunk as Buffer])

        while (remainder.length >= frameSize) {
          throwIfAborted(signal)
          const frameBuffer = remainder.subarray(0, frameSize)
          remainder = remainder.subarray(frameSize)
          const processed = blurVideoFrame(
            {
              data: new Uint8ClampedArray(frameBuffer),
              width: metadata.width,
              height: metadata.height
            },
            settings,
            resolveFaces,
            frameIndex
          )

          await writeFrame(encoder.stdin, processed, signal)
          onProgress?.(getFrameProcessingProgress(frameIndex, metadata.frameCount))
          frameIndex += 1
        }
      }

      if (remainder.length > 0) {
        throw new Error('Le flux video brut est incomplet.')
      }

      encoder.stdin.end()
      await decoderDone
      await encoderDone
      onProgress?.(1)

      return { outputPath, tempRoot }
    } catch (cause) {
      await silenceProcess(decoder, decoderDone)
      encoder.stdin.destroy()
      await silenceProcess(encoder, encoderDone)
      throw cause
    }
  } catch (cause) {
    await rm(tempRoot, { recursive: true, force: true })

    if (cause instanceof Error) {
      throw new Error(`Le traitement video serveur a echoue : ${cause.message}`)
    }

    throw new Error('Le traitement video serveur a echoue.')
  }
}
