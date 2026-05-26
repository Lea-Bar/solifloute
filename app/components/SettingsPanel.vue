<script setup lang="ts">
import { computed } from 'vue'
import type { EditorSettings, ProcessingMode } from '~~/shared/types/faces'

const settings = defineModel<EditorSettings>({ required: true })

const props = defineProps<{
  activeMode: Exclude<ProcessingMode, 'auto'>
  detectedCount: number
}>()

const processingItems = computed(() => [
  { label: `Auto (${props.activeMode === 'client' ? 'navigateur' : 'serveur'})`, value: 'auto' },
  { label: 'Navigateur', value: 'client' },
  { label: 'Serveur', value: 'server' }
])

const outputFormatItems = [
  { label: 'PNG (sans perte)', value: 'png' },
  { label: 'JPG (plus leger)', value: 'jpeg' }
]

function normalizeSliderValue(value: number | number[]) {
  const nextValue = Array.isArray(value) ? value[0] : value

  return typeof nextValue === 'number' && Number.isFinite(nextValue) ? nextValue : 0
}

const detectionSensitivity = computed({
  get: () => Number((1 - settings.value.confidenceThreshold).toFixed(2)),
  set: (value: number | number[]) => {
    const nextValue = normalizeSliderValue(value)
    settings.value.confidenceThreshold = Number((1 - nextValue).toFixed(2))
  }
})

const blurIntensity = computed({
  get: () => Number(settings.value.blurIntensity.toFixed(2)),
  set: (value: number | number[]) => {
    settings.value.blurIntensity = Number(normalizeSliderValue(value).toFixed(2))
  }
})
</script>

<template>
  <UCard class="border-(--ui-border) bg-(--ui-bg-muted)">
    <template #header>
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-2xl">
            Parametres de floutage
          </h2>
        </div>

        <UBadge
          color="neutral"
          variant="subtle"
          size="lg"
        >
          {{ detectedCount }} visage{{ detectedCount === 1 ? '' : 's' }}
        </UBadge>
      </div>
    </template>

    <div class="space-y-6">
      <UFormField label="Cible de traitement">
        <USelect
          v-model="settings.processingMode"
          :items="processingItems"
        />
      </UFormField>

      <UFormField label="Format de sortie (image uniquement)">
        <USelect
          v-model="settings.outputFormat"
          :items="outputFormatItems"
        />
      </UFormField>

      <div class="space-y-2">
        <div class="flex items-center justify-between text-sm">
          <span>Sensibilité de détection</span>
          <span class="font-semibold">{{ detectionSensitivity.toFixed(2) }}</span>
        </div>
        <USlider
          v-model="detectionSensitivity"
          :min="0"
          :max="1"
          :step="0.01"
        />
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between text-sm">
          <span>Intensité du floutage</span>
          <span class="font-semibold">{{ blurIntensity.toFixed(2) }}</span>
        </div>
        <USlider
          v-model="blurIntensity"
          :min="0"
          :max="1"
          :step="0.01"
        />
      </div>
    </div>
  </UCard>
</template>
