import type { EditorSettings, Face, ProcessingMode } from '~~/shared/types/faces'
import { applyBlurEffects } from '~~/shared/utils/imageProcessing'
import { useFaceDetector } from '~~/shared/utils/useFaceDetector'
import { fileToBase64, fileToImageData, imageDataToDetectionInput, imageDataToObjectUrl } from '~/utils/image-io'
import { inferProcessingTarget } from '~/utils/machine-profile'
import { processVideoInBrowser } from '~/utils/video-browser'

const MODEL_URL = '/models/version-RFB-640.onnx'

const DEFAULT_SETTINGS: EditorSettings = {
  confidenceThreshold: 0.2,
  detectionIntervalSeconds: 1,
  processingMode: 'auto',
  excludedFaceIds: []
}

type EditorStatus = 'idle' | 'detecting' | 'processing' | 'ready' | 'error'
type MediaKind = 'image' | 'video'

interface UploadEntry {
  id: string
  createdAt: number
  fileName: string
  mediaKind: MediaKind
  originalPreviewUrl: string
  processedPreviewUrl: string
  faces: Face[]
  status: EditorStatus
  error: string
  lastDurationMs: number | null
  processingProgress: number | null
  estimatedRemainingMs: number | null
}

interface DetectResponse {
  faces: Face[]
  durationMs: number
}

interface WorkerDetectSuccess extends DetectResponse {
  type: 'detect:success'
}

interface WorkerProcessSuccess {
  type: 'process:success'
  faces: Face[]
  processedImageData: ImageData
  durationMs: number
}

interface WorkerError {
  type: 'error'
  message: string
}

interface VideoJobResponse {
  id: string
  status: 'queued' | 'processing' | 'completed' | 'error'
  progress: number
  error: string
  downloadUrl: string | null
}

function clampProgress(progress: number | null) {
  if (progress === null || !Number.isFinite(progress)) {
    return null
  }

  return Math.max(0, Math.min(1, progress))
}

function isSafariBrowser() {
  if (!import.meta.client) {
    return false
  }

  const userAgent = navigator.userAgent
  const vendor = navigator.vendor

  return (
    userAgent.includes('Safari')
    && vendor.includes('Apple')
    && !/Chrome|CriOS|FxiOS|EdgiOS|OPiOS|OPR|Android/.test(userAgent)
  )
}

function isManualFace(face: Face) {
  return face.id.startsWith('manual:')
}

export function useImageEditor() {
  let videoRunId = 0
  let detectRunId = 0

  const file = shallowRef<File | null>(null)
  const originalImageData = shallowRef<ImageData | null>(null)
  const uploadEntries = ref<UploadEntry[]>([])
  const currentEntryId = ref<string | null>(null)
  const settings = reactive<EditorSettings>({ ...DEFAULT_SETTINGS })
  const autoResolvedMode = ref<Exclude<ProcessingMode, 'auto'>>('client')
  const processingStartedAt = ref<number | null>(null)
  const safariVideoModalOpen = ref(false)
  const isSafari = isSafariBrowser()
  const clientDetector = import.meta.client ? useFaceDetector(MODEL_URL) : null
  const worker = import.meta.client
    ? new Worker(new URL('../workers/imageProcessor.worker.ts', import.meta.url), { type: 'module' })
    : null

  const currentEntry = computed(() => (
    currentEntryId.value
      ? uploadEntries.value.find(entry => entry.id === currentEntryId.value) || null
      : null
  ))

  const isSafariVideoForcedToServer = computed(() => (
    isSafari
    && mediaKind.value === 'video'
  ))

  const activeMode = computed(() => {
    if (isSafariVideoForcedToServer.value) {
      return 'server'
    }

    return settings.processingMode === 'auto' ? autoResolvedMode.value : settings.processingMode
  })

  const mediaKind = computed(() => currentEntry.value?.mediaKind ?? null)
  const faces = computed(() => currentEntry.value?.faces ?? [])
  const status = computed(() => currentEntry.value?.status ?? 'idle')
  const error = computed(() => currentEntry.value?.error ?? '')
  const lastDurationMs = computed(() => currentEntry.value?.lastDurationMs ?? null)
  const originalPreviewUrl = computed(() => currentEntry.value?.originalPreviewUrl ?? '')
  const processedPreviewUrl = computed(() => currentEntry.value?.processedPreviewUrl ?? '')
  const processingProgress = computed(() => currentEntry.value?.processingProgress ?? null)
  const estimatedRemainingMs = computed(() => currentEntry.value?.estimatedRemainingMs ?? null)

  function revokeUrl(url: string) {
    if (url) {
      URL.revokeObjectURL(url)
    }
  }

  function revokeEntryUrls(entry: UploadEntry) {
    revokeUrl(entry.originalPreviewUrl)
    revokeUrl(entry.processedPreviewUrl)
  }

  function revokeAllEntryUrls() {
    for (const entry of uploadEntries.value) {
      revokeEntryUrls(entry)
    }
  }

  function updateCurrentEntry(patch: Partial<UploadEntry>) {
    if (!currentEntry.value) {
      return
    }

    Object.assign(currentEntry.value, patch)
  }

  function setStatus(nextStatus: EditorStatus, nextError = '') {
    updateCurrentEntry({
      status: nextStatus,
      error: nextError
    })
  }

  function updateProgress(progress: number | null) {
    const normalizedProgress = clampProgress(progress)
    const startedAt = processingStartedAt.value
    const remainingMs = (
      startedAt
      && normalizedProgress !== null
      && normalizedProgress > 0
      && normalizedProgress < 1
    )
      ? Math.max(0, ((Date.now() - startedAt) / normalizedProgress) - (Date.now() - startedAt))
      : null

    updateCurrentEntry({
      processingProgress: normalizedProgress,
      estimatedRemainingMs: remainingMs
    })
  }

  function getCurrentManualFaces() {
    return currentEntry.value?.faces.filter(isManualFace) ?? []
  }

  function applyDetection(result: DetectResponse) {
    updateCurrentEntry({
      faces: [...result.faces, ...getCurrentManualFaces()],
      lastDurationMs: result.durationMs
    })
  }

  function createSettingsSnapshot(): EditorSettings {
    return {
      confidenceThreshold: settings.confidenceThreshold,
      detectionIntervalSeconds: settings.detectionIntervalSeconds,
      processingMode: settings.processingMode,
      excludedFaceIds: [...settings.excludedFaceIds]
    }
  }

  async function setProcessedPreview(url: string) {
    if (!currentEntry.value) {
      revokeUrl(url)
      return
    }

    revokeUrl(currentEntry.value.processedPreviewUrl)
    updateCurrentEntry({ processedPreviewUrl: url })
  }

  async function refreshClientPreview(nextFaces = faces.value) {
    if (!originalImageData.value) {
      return
    }

    const imageData = originalImageData.value
    const processedImageData = new ImageData(
      applyBlurEffects(
        imageDataToDetectionInput(imageData),
        nextFaces,
        settings.excludedFaceIds
      ),
      imageData.width,
      imageData.height
    )

    await setProcessedPreview(await imageDataToObjectUrl(processedImageData))
  }

  async function detectOnClient() {
    if (!originalImageData.value || !clientDetector) {
      throw new Error('La detection des visages dans le navigateur est indisponible.')
    }

    return await clientDetector.detectFaces(
      imageDataToDetectionInput(originalImageData.value),
      settings.confidenceThreshold
    )
  }

  async function detectInWorker() {
    if (!worker || !originalImageData.value) {
      return await detectOnClient()
    }

    return await new Promise<DetectResponse>((resolve, reject) => {
      const handleMessage = (event: MessageEvent<WorkerDetectSuccess | WorkerError>) => {
        if (event.data.type === 'error') {
          worker.removeEventListener('message', handleMessage)
          reject(new Error(event.data.message))
          return
        }

        if (event.data.type !== 'detect:success') {
          return
        }

        worker.removeEventListener('message', handleMessage)
        resolve({
          faces: event.data.faces,
          durationMs: event.data.durationMs
        })
      }

      worker.addEventListener('message', handleMessage)
      worker.postMessage({
        type: 'detect',
        imageData: originalImageData.value,
        threshold: settings.confidenceThreshold,
        modelUrl: MODEL_URL
      })
    })
  }

  async function detectOnServer() {
    if (!file.value) {
      throw new Error('Aucune image n a ete chargee.')
    }

    return await $fetch<DetectResponse>('/api/process-image', {
      method: 'POST',
      body: {
        action: 'detect',
        imageBase64: await fileToBase64(file.value),
        fileName: file.value.name,
        mimeType: file.value.type,
        settings: createSettingsSnapshot()
      }
    })
  }

  async function detectFaces() {
    if (mediaKind.value !== 'image' || !originalImageData.value || !currentEntry.value) {
      return
    }

    const runId = ++detectRunId
    setStatus('detecting')

    try {
      const result = activeMode.value === 'server'
        ? await detectOnServer()
        : await detectInWorker()

      if (runId !== detectRunId || !currentEntry.value) {
        return
      }

      applyDetection(result)

      if (activeMode.value === 'client') {
        await refreshClientPreview(result.faces)
      }

      setStatus('ready')
    } catch (cause) {
      if (runId !== detectRunId) {
        return
      }

      setStatus(
        'error',
        cause instanceof Error ? cause.message : 'La detection des visages a echoue.'
      )
    }
  }

  async function processOnClient() {
    const result = await detectOnClient()
    applyDetection(result)
    await refreshClientPreview(result.faces)
  }

  async function processInWorker() {
    if (!worker || !originalImageData.value) {
      await processOnClient()
      return
    }

    const response = await new Promise<WorkerProcessSuccess>((resolve, reject) => {
      const handleMessage = (event: MessageEvent<WorkerProcessSuccess | WorkerError>) => {
        if (event.data.type === 'error') {
          worker.removeEventListener('message', handleMessage)
          reject(new Error(event.data.message))
          return
        }

        if (event.data.type !== 'process:success') {
          return
        }

        worker.removeEventListener('message', handleMessage)
        resolve(event.data)
      }

      worker.addEventListener('message', handleMessage)
      worker.postMessage({
        type: 'process',
        imageData: originalImageData.value,
        settings: createSettingsSnapshot(),
        manualFaces: getCurrentManualFaces(),
        modelUrl: MODEL_URL
      })
    })

    applyDetection({
      faces: response.faces,
      durationMs: response.durationMs
    })
    await setProcessedPreview(await imageDataToObjectUrl(response.processedImageData))
  }

  async function processOnServer() {
    if (!file.value) {
      throw new Error('Aucune image n a ete chargee.')
    }

    const response = await $fetch.raw('/api/process-image', {
      method: 'POST',
      body: {
        action: 'process',
        imageBase64: await fileToBase64(file.value),
        fileName: file.value.name,
        mimeType: file.value.type,
        settings: createSettingsSnapshot(),
        manualFaces: getCurrentManualFaces()
      },
      responseType: 'blob'
    })

    if (!(response._data instanceof Blob)) {
      throw new Error('Le serveur n a pas renvoye de blob image.')
    }

    await setProcessedPreview(URL.createObjectURL(response._data))
  }

  async function processVideo() {
    if (!file.value || !currentEntry.value) {
      return
    }

    const runId = ++videoRunId
    const startedAt = Date.now()
    processingStartedAt.value = startedAt
    setStatus('processing')
    updateProgress(0)

    try {
      let blob: Blob | null = null

      if (activeMode.value === 'server') {
        const body = new FormData()
        body.append('file', file.value)
        body.append('settings', JSON.stringify(createSettingsSnapshot()))

        const { jobId } = await $fetch<{ jobId: string }>('/api/process-video', {
          method: 'POST',
          body
        })

        while (runId === videoRunId) {
          const job = await $fetch<VideoJobResponse>(`/api/process-jobs/${jobId}`)

          updateProgress(job.progress)

          if (job.status === 'completed') {
            const downloadUrl = job.downloadUrl || `/api/process-jobs/${jobId}/download`
            const response = await $fetch.raw(downloadUrl, { responseType: 'blob' })

            if (!(response._data instanceof Blob)) {
              throw new Error('Le serveur n a pas renvoye de blob video.')
            }

            blob = response._data
            break
          }

          if (job.status === 'error') {
            throw new Error(job.error || 'Le traitement de la video a echoue.')
          }

          await new Promise(resolve => setTimeout(resolve, 500))
        }
      } else {
        blob = await processVideoInBrowser(file.value, createSettingsSnapshot(), updateProgress)
      }

      if (runId !== videoRunId) {
        return
      }

      if (!blob) {
        throw new Error('Aucun resultat video n a ete produit.')
      }

      await setProcessedPreview(URL.createObjectURL(blob))
      updateCurrentEntry({
        lastDurationMs: Date.now() - startedAt
      })
      setStatus('ready')
    } catch (cause) {
      if (runId !== videoRunId) {
        return
      }

      setStatus(
        'error',
        cause instanceof Error ? cause.message : 'Le traitement de la video a echoue.'
      )
    } finally {
      if (runId === videoRunId) {
        processingStartedAt.value = null
        updateProgress(null)
      }
    }
  }

  async function processImage() {
    if (!file.value || !currentEntry.value) {
      return
    }

    if (mediaKind.value === 'video') {
      await processVideo()
      return
    }

    setStatus('processing')

    try {
      if (activeMode.value === 'server') {
        await processOnServer()
      } else {
        await processInWorker()
      }

      setStatus('ready')
    } catch (cause) {
      setStatus(
        'error',
        cause instanceof Error ? cause.message : 'Le traitement de l image a echoue.'
      )
    }
  }

  async function loadFile(nextFile: File) {
    videoRunId += 1
    detectRunId += 1
    file.value = nextFile
    originalImageData.value = null
    settings.excludedFaceIds = []
    processingStartedAt.value = null

    const mediaKind = nextFile.type.startsWith('video/') ? 'video' : 'image'
    const entryId = crypto.randomUUID()
    currentEntryId.value = entryId
    uploadEntries.value.unshift({
      id: entryId,
      createdAt: Date.now(),
      fileName: nextFile.name,
      mediaKind,
      originalPreviewUrl: URL.createObjectURL(nextFile),
      processedPreviewUrl: '',
      faces: [],
      status: mediaKind === 'video' ? 'ready' : 'detecting',
      error: '',
      lastDurationMs: null,
      processingProgress: null,
      estimatedRemainingMs: null
    })

    autoResolvedMode.value = await inferProcessingTarget(nextFile.size)
    safariVideoModalOpen.value = mediaKind === 'video' && isSafari

    if (mediaKind === 'video') {
      return
    }

    originalImageData.value = await fileToImageData(nextFile)
    await detectFaces()
  }

  function clear() {
    videoRunId += 1
    detectRunId += 1
    file.value = null
    originalImageData.value = null
    settings.excludedFaceIds = []
    processingStartedAt.value = null
    currentEntryId.value = null
    revokeAllEntryUrls()
    uploadEntries.value = []
  }

  function toggleExcludedFace(faceId: string) {
    settings.excludedFaceIds = settings.excludedFaceIds.includes(faceId)
      ? settings.excludedFaceIds.filter(id => id !== faceId)
      : [...settings.excludedFaceIds, faceId]
  }

  async function addManualFace(bounds: Pick<Face, 'x' | 'y' | 'width' | 'height'>) {
    if (!currentEntry.value || mediaKind.value !== 'image') {
      return
    }

    updateCurrentEntry({
      faces: [
        ...currentEntry.value.faces,
        {
          id: `manual:${crypto.randomUUID()}`,
          confidence: 1,
          ...bounds
        }
      ]
    })

    if (activeMode.value === 'client' && originalImageData.value) {
      try {
        await refreshClientPreview()
      } catch (cause) {
        setStatus(
          'error',
          cause instanceof Error ? cause.message : 'La mise a jour de l apercu a echoue.'
        )
      }
    }
  }

  function closeSafariVideoModal() {
    safariVideoModalOpen.value = false
  }

  watch(() => settings.confidenceThreshold, async () => {
    if (mediaKind.value === 'image' && file.value && originalImageData.value) {
      await detectFaces()
    }
  })

  watch(
    () => [settings.processingMode, settings.excludedFaceIds.join('|')],
    async () => {
      if (
        mediaKind.value !== 'image'
        || !file.value
        || !originalImageData.value
        || activeMode.value !== 'client'
        || status.value === 'detecting'
      ) {
        return
      }

      try {
        await refreshClientPreview()
      } catch (cause) {
        setStatus(
          'error',
          cause instanceof Error ? cause.message : 'La mise a jour de l apercu a echoue.'
        )
      }
    }
  )

  watch(
    () => settings.processingMode,
    () => {
      if (isSafariVideoForcedToServer.value && settings.processingMode !== 'server') {
        safariVideoModalOpen.value = true
      }
    }
  )

  onScopeDispose(() => {
    revokeAllEntryUrls()
    worker?.terminate()
  })

  return {
    file,
    uploadEntries,
    currentEntryId,
    mediaKind,
    faces,
    status,
    error,
    settings,
    activeMode,
    originalPreviewUrl,
    processedPreviewUrl,
    processingProgress,
    estimatedRemainingMs,
    lastDurationMs,
    safariVideoModalOpen,
    isSafariVideoForcedToServer,
    loadFile,
    clear,
    detectFaces,
    processImage,
    toggleExcludedFace,
    addManualFace,
    closeSafariVideoModal
  }
}
