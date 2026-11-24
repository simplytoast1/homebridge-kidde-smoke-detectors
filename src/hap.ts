import type { HAP } from 'homebridge'

/**
 * The HAP instance Homebridge hands the plugin at registration. Kept in one
 * place so every module uses the same classes Homebridge itself uses.
 */
export let hap: HAP

export function setHap(hapInstance: HAP): void {
  hap = hapInstance
}
