/**
 * Preloaded (node --import) into the settings server child process so its
 * Kidde requests go to the fake Kidde instead of the internet.
 */
import { createKiddeServer } from './kidde-server.mjs'

const kidde = createKiddeServer({ email: 'owner@example.com', password: 'correct horse' })
kidde.locations = [{ id: 1, name: 'Home' }, { id: 2, name: 'Cabin' }]
kidde.devices[1] = [
  { id: 101, label: 'Kitchen', model: 'wifidetector', serial_number: 'SN101', capabilities: ['smoke', 'co'], battery_state: 'ok' },
  { id: 103, label: 'Water Heater', model: 'waterleakdetector', capabilities: ['temperature'] },
]
kidde.devices[2] = [
  { id: 201, label: 'Loft', model: 'EssWFAC', serial_number: 'SN201', capabilities: ['Smoke'], battery_state: 'Good', offline: true },
]
globalThis.fetch = kidde.fetch
