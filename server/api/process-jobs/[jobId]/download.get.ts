import { getRouterParam } from 'h3'
import { getOrCreateClientId } from '../../../utils/job-client'
import { getJobForOwner, readJobOutput } from '../../../utils/video-jobs'

export default defineEventHandler(async (event) => {
  const ownerId = getOrCreateClientId(event)
  const jobId = getRouterParam(event, 'jobId')

  if (!jobId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Identifiant de tache manquant.'
    })
  }

  const job = getJobForOwner(jobId, ownerId)

  if (!job) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Resultat introuvable.'
    })
  }

  const output = await readJobOutput(jobId)

  if (!output) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Le resultat n est pas disponible.'
    })
  }

  setHeader(event, 'content-type', job.mimeType || 'application/octet-stream')
  setHeader(event, 'cache-control', 'no-store')
  return output
})
