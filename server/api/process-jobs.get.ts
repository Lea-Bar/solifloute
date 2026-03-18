import { getOrCreateClientId } from '../utils/job-client'
import { serializeJob } from '../utils/job-response'
import { listJobsForOwner } from '../utils/video-jobs'

export default defineEventHandler((event) => {
  const ownerId = getOrCreateClientId(event)
  const jobs = listJobsForOwner(ownerId)

  return {
    jobs: jobs.map(serializeJob)
  }
})
