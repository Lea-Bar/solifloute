<script setup lang="ts">
import type { Face } from '~~/shared/types/faces'

const props = defineProps<{
  src: string
  faces: Face[]
  excludedFaceIds: string[]
}>()

const emit = defineEmits<{
  toggle: [faceId: string]
  create: [face: Pick<Face, 'x' | 'y' | 'width' | 'height'>]
}>()

const imageRef = ref<HTMLImageElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const naturalSize = reactive({
  width: 1,
  height: 1
})
const draftFace = ref<Pick<Face, 'x' | 'y' | 'width' | 'height'> | null>(null)
let dragStart: { x: number, y: number } | null = null

function updateNaturalSize() {
  if (!imageRef.value) {
    return
  }

  naturalSize.width = imageRef.value.naturalWidth || 1
  naturalSize.height = imageRef.value.naturalHeight || 1
}

function isExcluded(faceId: string) {
  return props.excludedFaceIds.includes(faceId)
}

function isManualFace(faceId: string) {
  return faceId.startsWith('manual:')
}

function toSvgPoint(event: PointerEvent) {
  if (!svgRef.value) {
    return null
  }

  const bounds = svgRef.value.getBoundingClientRect()

  if (bounds.width <= 0 || bounds.height <= 0) {
    return null
  }

  const x = ((event.clientX - bounds.left) / bounds.width) * naturalSize.width
  const y = ((event.clientY - bounds.top) / bounds.height) * naturalSize.height

  return {
    x: Math.max(0, Math.min(naturalSize.width, x)),
    y: Math.max(0, Math.min(naturalSize.height, y))
  }
}

function updateDraftFace(point: { x: number, y: number }) {
  if (!dragStart) {
    return
  }

  draftFace.value = {
    x: Math.round(Math.min(dragStart.x, point.x)),
    y: Math.round(Math.min(dragStart.y, point.y)),
    width: Math.round(Math.abs(point.x - dragStart.x)),
    height: Math.round(Math.abs(point.y - dragStart.y))
  }
}

function startDrawing(event: PointerEvent) {
  if (event.button !== 0) {
    return
  }

  const point = toSvgPoint(event)

  if (!point || !svgRef.value) {
    return
  }

  dragStart = point
  draftFace.value = {
    x: Math.round(point.x),
    y: Math.round(point.y),
    width: 0,
    height: 0
  }
  svgRef.value.setPointerCapture(event.pointerId)
}

function continueDrawing(event: PointerEvent) {
  const point = toSvgPoint(event)

  if (!point) {
    return
  }

  updateDraftFace(point)
}

function finishDrawing(event: PointerEvent) {
  const point = toSvgPoint(event)

  if (point) {
    updateDraftFace(point)
  }

  if (svgRef.value?.hasPointerCapture(event.pointerId)) {
    svgRef.value.releasePointerCapture(event.pointerId)
  }

  const nextFace = draftFace.value
  dragStart = null
  draftFace.value = null

  if (!nextFace || nextFace.width < 12 || nextFace.height < 12) {
    return
  }

  emit('create', nextFace)
}

function cancelDrawing(event: PointerEvent) {
  if (svgRef.value?.hasPointerCapture(event.pointerId)) {
    svgRef.value.releasePointerCapture(event.pointerId)
  }

  dragStart = null
  draftFace.value = null
}
</script>

<template>
  <div class="relative overflow-hidden border border-(--ui-border) bg-black/10">
    <img
      ref="imageRef"
      :src="src"
      class="block h-auto w-full"
      alt="Apercu de l image importee"
      @load="updateNaturalSize"
    >

    <svg
      ref="svgRef"
      class="absolute inset-0 h-full w-full"
      :viewBox="`0 0 ${naturalSize.width} ${naturalSize.height}`"
      preserveAspectRatio="xMidYMid meet"
      @pointermove="continueDrawing"
      @pointerup="finishDrawing"
      @pointercancel="cancelDrawing"
    >
      <rect
        x="0"
        y="0"
        :width="naturalSize.width"
        :height="naturalSize.height"
        fill="transparent"
        @pointerdown="startDrawing"
      />

      <g
        v-for="face in faces"
        :key="face.id"
      >
        <rect
          :x="face.x"
          :y="face.y"
          :width="face.width"
          :height="face.height"
          :fill="isExcluded(face.id) ? 'rgba(68, 52, 39, 0.12)' : 'rgba(210, 8, 8, 0.12)'"
          :stroke="isExcluded(face.id) ? 'rgba(68, 52, 39, 0.85)' : 'rgba(210, 8, 8, 0.95)'"
          stroke-width="4"
          vector-effect="non-scaling-stroke"
          class="cursor-pointer transition-opacity"
          @click.prevent.stop="emit('toggle', face.id)"
        />
        <text
          :x="face.x + 8"
          :y="Math.max(18, face.y - 8)"
          :fill="isExcluded(face.id) ? '#332822' : '#d20808'"
          font-size="14"
          font-weight="700"
          pointer-events="none"
        >
          {{ isExcluded(face.id) ? 'Exclu' : isManualFace(face.id) ? 'Manuel' : `${Math.round(face.confidence * 100)}%` }}
        </text>
      </g>

      <rect
        v-if="draftFace"
        :x="draftFace.x"
        :y="draftFace.y"
        :width="draftFace.width"
        :height="draftFace.height"
        fill="rgba(210, 8, 8, 0.08)"
        stroke="rgba(210, 8, 8, 0.95)"
        stroke-dasharray="8 6"
        stroke-width="4"
        vector-effect="non-scaling-stroke"
        pointer-events="none"
      />
    </svg>
  </div>
</template>
