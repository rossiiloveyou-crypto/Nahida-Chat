import type { NahidaApi } from '@shared/api'

declare global {
  interface Window {
    nahida: NahidaApi
  }
}

export {}
