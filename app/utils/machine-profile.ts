import type { ProcessingMode } from '~~/shared/types/faces'

function readNavigatorNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export async function inferProcessingTarget(fileSize = 0): Promise<Exclude<ProcessingMode, 'auto'>> {
  if (!import.meta.client) {
    return 'server'
  }

  const fileSizeMb = fileSize / (1024 * 1024)
  const cpuCores = readNavigatorNumber(navigator.hardwareConcurrency, 4)
  const memoryGb = readNavigatorNumber((navigator as Navigator & { deviceMemory?: number }).deviceMemory, 4)

  if (fileSizeMb <= 6 && cpuCores >= 6 && memoryGb >= 4) {
    return 'client'
  }

  if (fileSizeMb <= 20 && cpuCores >= 8 && memoryGb >= 8) {
    return 'client'
  }

  return 'server'
}
