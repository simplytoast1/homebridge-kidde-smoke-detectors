import type { API } from 'homebridge'
import { KiddeSmokeDetectorsPlatform } from './platform.js'
import { setHap } from './hap.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

export default function (api: API): void {
  setHap(api.hap)
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, KiddeSmokeDetectorsPlatform)
}
