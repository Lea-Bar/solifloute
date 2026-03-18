interface BoxCandidate {
  x1: number
  y1: number
  x2: number
  y2: number
  score: number
}

function intersectionOverUnion(a: BoxCandidate, b: BoxCandidate) {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)
  const width = Math.max(0, x2 - x1)
  const height = Math.max(0, y2 - y1)
  const intersection = width * height
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1)
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)
  const union = areaA + areaB - intersection

  return union <= 0 ? 0 : intersection / union
}

export function hardNonMaxSuppression(boxes: BoxCandidate[], iouThreshold = 0.3, topK = -1) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score)
  const selected: BoxCandidate[] = []

  while (sorted.length > 0) {
    const candidate = sorted.shift()

    if (!candidate) {
      continue
    }

    selected.push(candidate)

    if (topK > 0 && selected.length >= topK) {
      break
    }

    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      if (intersectionOverUnion(candidate, sorted[index]!) > iouThreshold) {
        sorted.splice(index, 1)
      }
    }
  }

  return selected
}
