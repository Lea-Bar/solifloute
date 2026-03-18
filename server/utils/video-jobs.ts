import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'

export type ProcessingJobStatus = 'queued' | 'processing' | 'completed' | 'error'

export interface ProcessingJob {
  id: string
  ownerId: string
  kind: 'video-process'
  fileName: string
  mimeType: string
  status: ProcessingJobStatus
  progress: number
  error: string
  createdAt: number
  updatedAt: number
  durationMs: number | null
  outputPath: string
  tempRoot: string
}

const jobs = new Map<string, ProcessingJob>()
const queuedTasks = new Map<string, () => Promise<void>>()
const queue: string[] = []
const JOB_TTL_MS = 24 * 60 * 60 * 1000
const JOB_QUEUE_CONCURRENCY = Math.max(1, Number(process.env.PROCESS_JOB_CONCURRENCY || 1))
let activeTasks = 0

function touch(job: ProcessingJob) {
  job.updatedAt = Date.now()
}

function scheduleCleanup(jobId: string) {
  const timer = setTimeout(() => {
    void cleanupJob(jobId)
  }, JOB_TTL_MS)

  timer.unref?.()
}

async function runQueue() {
  while (activeTasks < JOB_QUEUE_CONCURRENCY && queue.length > 0) {
    const jobId = queue.shift()

    if (!jobId) {
      return
    }

    const job = jobs.get(jobId)
    const task = queuedTasks.get(jobId)

    if (!job || !task) {
      continue
    }

    queuedTasks.delete(jobId)
    activeTasks += 1
    job.status = 'processing'
    touch(job)

    void task()
      .catch(async (cause) => {
        await failJob(jobId, cause instanceof Error ? cause.message : 'Le traitement a echoue.')
      })
      .finally(() => {
        activeTasks = Math.max(0, activeTasks - 1)
        void runQueue()
      })
  }
}

export function createJob(input: {
  ownerId: string
  fileName: string
  mimeType?: string
}) {
  const id = randomUUID()
  const now = Date.now()

  jobs.set(id, {
    id,
    ownerId: input.ownerId,
    kind: 'video-process',
    fileName: input.fileName,
    mimeType: input.mimeType || 'video/mp4',
    status: 'queued',
    progress: 0,
    error: '',
    createdAt: now,
    updatedAt: now,
    durationMs: null,
    outputPath: '',
    tempRoot: ''
  })

  scheduleCleanup(id)
  return id
}

export function enqueueJob(jobId: string, task: () => Promise<void>) {
  if (!jobs.has(jobId)) {
    throw new Error('Tache introuvable.')
  }

  queuedTasks.set(jobId, task)
  queue.push(jobId)
  void runQueue()
}

export function getJobForOwner(jobId: string, ownerId: string) {
  const job = jobs.get(jobId)

  return job && job.ownerId === ownerId ? job : null
}

export function listJobsForOwner(ownerId: string) {
  return [...jobs.values()]
    .filter(job => job.ownerId === ownerId)
    .sort((left, right) => right.createdAt - left.createdAt)
}

export function updateJobProgress(jobId: string, progress: number) {
  const job = jobs.get(jobId)

  if (!job) {
    return
  }

  job.progress = Math.max(0, Math.min(1, progress))
  touch(job)
}

export function completeJob(
  jobId: string,
  payload: {
    outputPath: string
    tempRoot: string
    durationMs: number
    mimeType?: string
  }
) {
  const job = jobs.get(jobId)

  if (!job) {
    return
  }

  job.status = 'completed'
  job.progress = 1
  job.outputPath = payload.outputPath
  job.tempRoot = payload.tempRoot
  job.durationMs = payload.durationMs
  job.mimeType = payload.mimeType || job.mimeType
  touch(job)
}

export async function failJob(jobId: string, message: string) {
  const job = jobs.get(jobId)

  if (!job) {
    return
  }

  job.status = 'error'
  job.progress = 0
  job.error = message
  touch(job)

  if (job.tempRoot) {
    await rm(job.tempRoot, { recursive: true, force: true })
    job.tempRoot = ''
    job.outputPath = ''
  }
}

export async function readJobOutput(jobId: string) {
  const job = jobs.get(jobId)

  if (!job || job.status !== 'completed' || !job.outputPath) {
    return null
  }

  return await readFile(job.outputPath)
}

export async function cleanupJob(jobId: string) {
  const job = jobs.get(jobId)

  if (!job) {
    return
  }

  jobs.delete(jobId)
  queuedTasks.delete(jobId)

  if (job.tempRoot) {
    await rm(job.tempRoot, { recursive: true, force: true })
  }
}
