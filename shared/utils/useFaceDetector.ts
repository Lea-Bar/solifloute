import type { DetectionInput, DetectionResult } from '../types/faces'
import {
  createModelInputData,
  DEFAULT_PROBABILITY_THRESHOLD,
  extractFacesFromOutputs,
  MODEL_HEIGHT,
  MODEL_WIDTH,
  resolveOutputTensors
} from './faceDetectionCore'

const DEFAULT_MODEL_PATH = import.meta.server
  ? `${process.cwd()}/public/models/version-RFB-640.onnx`
  : '/models/version-RFB-640.onnx'

type OrtWebModule = typeof import('onnxruntime-web')
type OrtNodeModule = typeof import('onnxruntime-node')
type OrtModule = OrtWebModule | OrtNodeModule
type InferenceSession = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>

const sessionCache = new Map<string, Promise<InferenceSession>>()
let ortPromise: Promise<OrtModule> | null = null

function getExecutionProviders() {
  return import.meta.server ? ['cpu'] : ['wasm']
}

async function getOrt() {
  if (!ortPromise) {
    ortPromise = import.meta.server
      ? import('onnxruntime-node')
      : import('onnxruntime-web').then((ort) => {
          ort.env.wasm.wasmPaths = {
            mjs: '/ort/ort-wasm-simd-threaded.mjs',
            wasm: '/ort/ort-wasm-simd-threaded.wasm'
          }
          ort.env.wasm.numThreads = 1
          return ort
        })
  }

  return await ortPromise
}

async function loadSession(modelPath: string) {
  const cacheKey = `${import.meta.server ? 'server' : 'client'}:${modelPath}`

  if (!sessionCache.has(cacheKey)) {
    sessionCache.set(cacheKey, (async () => {
      const ort = await getOrt()
      return await ort.InferenceSession.create(modelPath, {
        executionProviders: getExecutionProviders()
      })
    })())
  }

  return await sessionCache.get(cacheKey)!
}

export function useFaceDetector(modelPath = DEFAULT_MODEL_PATH) {
  return {
    async detectFaces(
      input: DetectionInput,
      probabilityThreshold = DEFAULT_PROBABILITY_THRESHOLD
    ): Promise<DetectionResult> {
      const startedAt = performance.now()
      const [ort, session] = await Promise.all([
        getOrt(),
        loadSession(modelPath)
      ])
      const inputName = session.inputNames[0]

      if (!inputName) {
        throw new Error('Le modele de detection de visages n a pas de nom d entree.')
      }

      const tensor = new ort.Tensor(
        'float32',
        createModelInputData(input),
        [1, 3, MODEL_HEIGHT, MODEL_WIDTH]
      )
      const outputs = await session.run({ [inputName]: tensor })
      const { boxTensor, confidenceTensor } = resolveOutputTensors(outputs, session.outputNames)

      return {
        faces: extractFacesFromOutputs(
          boxTensor.data as Float32Array,
          confidenceTensor.data as Float32Array,
          input,
          probabilityThreshold
        ),
        durationMs: performance.now() - startedAt
      }
    }
  }
}
