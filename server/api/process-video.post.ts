import type { EditorSettings } from '~~/shared/types/faces'
import { getOrCreateClientId } from '../utils/job-client'
import { processVideoToFile } from '../utils/process-video'
import { completeJob, createJob, enqueueJob, failJob, updateJobProgress } from '../utils/video-jobs'

interface MultipartField {
  name?: string
  data?: Buffer
  filename?: string
}

function readSettingsField(value?: Buffer) {
  if (!value) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Les reglages video sont requis.'
    })
  }

  try {
    return JSON.parse(value.toString('utf8')) as EditorSettings
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: 'Les reglages video sont invalides.'
    })
  }
}

export default defineEventHandler(async (event) => {
  const ownerId = getOrCreateClientId(event)
  const parts = await readMultipartFormData(event)

  if (!parts?.length) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Un fichier video et des reglages sont requis.'
    })
  }

  const filePart = parts.find(part => part.name === 'file') as MultipartField | undefined
  const settingsPart = parts.find(part => part.name === 'settings') as MultipartField | undefined

  if (!filePart?.data || !filePart.filename) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Le fichier video est requis.'
    })
  }

  const settings = readSettingsField(settingsPart?.data)
  const jobId = createJob({
    ownerId,
    fileName: filePart.filename,
    mimeType: 'video/mp4'
  })

  enqueueJob(jobId, async () => {
    const startedAt = Date.now()

    try {
      const { outputPath, tempRoot } = await processVideoToFile(filePart.data!, filePart.filename!, settings, (progress) => {
        updateJobProgress(jobId, progress)
      })

      completeJob(jobId, {
        outputPath,
        tempRoot,
        durationMs: Date.now() - startedAt,
        mimeType: 'video/mp4'
      })
    } catch (error) {
      await failJob(jobId, error instanceof Error ? error.message : 'Le traitement de la video a echoue.')
    }
  })

  return { jobId }
})
