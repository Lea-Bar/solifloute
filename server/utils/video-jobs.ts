import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type ProcessingJobStatus = 'queued' | 'processing' | 'completed' | 'error' | 'cancelled'

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
const queuedTasks = new Map<string, (signal: AbortSignal) => Promise<void>>()
const activeControllers = new Map<string, AbortController>()
const queue: string[] = []
const JOB_TTL_MS = 24 * 60 * 60 * 1000
const JOB_QUEUE_CONCURRENCY = Math.max(1, Number(process.env.PROCESS_JOB_CONCURRENCY || 1))
const JOB_QUEUE_LIMIT_PER_OWNER = Math.max(1, Number(process.env.PROCESS_JOB_LIMIT_PER_OWNER || 3))
const JOB_STORE_ROOT = process.env.PROCESS_JOB_STORE || join(process.cwd(), '.data', 'video-jobs')
const JOB_STORE_PATH = join(JOB_STORE_ROOT, 'jobs.json')
let activeTasks = 0

function isTerminalStatus(status: ProcessingJobStatus) {
  return status === 'completed' || status === 'error' || status === 'cancelled'
}

function ensureStoreRoot() {
  mkdirSync(JOB_STORE_ROOT, { recursive: true })
}

function loadJobsFromDisk() {
  if (!existsSync(JOB_STORE_PATH)) {
    return
  }

  try {
    const parsed = JSON.parse(readFileSync(JOB_STORE_PATH, 'utf8')) as ProcessingJob[]

    for (const job of parsed) {
      const restoredJob = {
        ...job,
        status: isTerminalStatus(job.status) ? job.status : 'error' as const,
        progress: isTerminalStatus(job.status) ? job.progress : 0,
        error: isTerminalStatus(job.status) ? job.error : 'Le serveur a ete redemarre pendant le traitement.'
      }

      jobs.set(restoredJob.id, restoredJob)
      scheduleCleanup(
        restoredJob.id,
        Math.max(0, (restoredJob.createdAt + JOB_TTL_MS) - Date.now())
      )
    }
    persistJobsSoon()
  } catch {
    // Ignore a corrupt store and allow new jobs to proceed.
  }
}

async function persistJobs() {
  await mkdir(dirname(JOB_STORE_PATH), { recursive: true })
  await writeFile(
    JOB_STORE_PATH,
    JSON.stringify([...jobs.values()], null, 2),
    'utf8'
  )
}

function persistJobsSoon() {
  void persistJobs()
}

function touch(job: ProcessingJob) {
  job.updatedAt = Date.now()
  persistJobsSoon()
}

function scheduleCleanup(jobId: string, delayMs = JOB_TTL_MS) {
  const timer = setTimeout(() => {
    void cleanupJob(jobId)
  }, delayMs)

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
    const controller = new AbortController()
    activeControllers.set(jobId, controller)
    activeTasks += 1
    job.status = 'processing'
    touch(job)

    void task(controller.signal)
      .catch(async (cause) => {
        if (controller.signal.aborted) {
          await cancelJob(jobId)
          return
        }

        await failJob(jobId, cause instanceof Error ? cause.message : 'Le traitement a echoue.')
      })
      .finally(() => {
        activeControllers.delete(jobId)
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
  const activeOwnerJobs = [...jobs.values()].filter(job => (
    job.ownerId === input.ownerId
    && (job.status === 'queued' || job.status === 'processing')
  ))

  if (activeOwnerJobs.length >= JOB_QUEUE_LIMIT_PER_OWNER) {
    throw new Error('Trop de traitements video sont deja en attente pour ce client.')
  }

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
  persistJobsSoon()
  return id
}

export function enqueueJob(jobId: string, task: (signal: AbortSignal) => Promise<void>) {
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

  if (job.status === 'cancelled') {
    void rm(payload.tempRoot, { recursive: true, force: true })
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

  if (job.status === 'cancelled') {
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
    touch(job)
  }
}

export async function cancelJob(jobId: string) {
  const job = jobs.get(jobId)

  if (!job || isTerminalStatus(job.status)) {
    return job || null
  }

  const controller = activeControllers.get(jobId)
  controller?.abort()
  queuedTasks.delete(jobId)

  const queueIndex = queue.indexOf(jobId)

  if (queueIndex >= 0) {
    queue.splice(queueIndex, 1)
  }

  job.status = 'cancelled'
  job.progress = 0
  job.error = 'Traitement annule.'
  touch(job)

  if (job.tempRoot) {
    await rm(job.tempRoot, { recursive: true, force: true })
    job.tempRoot = ''
    job.outputPath = ''
    touch(job)
  }

  return job
}

export async function cancelJobForOwner(jobId: string, ownerId: string) {
  const job = getJobForOwner(jobId, ownerId)

  if (!job) {
    return null
  }

  return await cancelJob(jobId)
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
  activeControllers.get(jobId)?.abort()
  activeControllers.delete(jobId)
  persistJobsSoon()

  if (job.tempRoot) {
    await rm(job.tempRoot, { recursive: true, force: true })
  }
}

ensureStoreRoot()
loadJobsFromDisk()
