# Changelog

## 1.0.1 (2026-11-24)

- Declares that the plugin's accessories are HomeKit (HAP) accessories, with the `supports-hap` keyword that Homebridge verification now requires. Nothing else changes.

## 1.0.0 (2026-11-24)

First release.

- Kidde HomeSafe Wi-Fi smoke alarms in HomeKit: a Smoke Sensor for every alarm, plus a Carbon Monoxide Sensor (with CO level) on smoke + CO models.
- Smoke is also reported when an alarm sounds because an interconnected alarm detected smoke.
- Battery level and low-battery warning, accepting every battery spelling Kidde is known to use ("ok", "Good", "Normal", "Low", "warning") and the low-battery fault flags. Unknown spellings are logged and never treated as low.
- Fault status for end-of-life warnings, sensor faults and device errors.
- Alarms show as No Response when Kidde reports them offline, when the plugin cannot get fresh data, or when Kidde sends an alarm state the plugin cannot read, instead of a stale or guessed "no smoke". Staleness is checked on its own timer and at every HomeKit read, on a clock that ignores system time changes. Offline, fault and low-battery flags are read as leniently as alarm states, so a 1 or "true" from Kidde counts the same as true.
- Sessions are reused across restarts (stored owner-only, bound to the account) and renewed automatically when Kidde ends them. A refusal of one location or command does not trigger a new sign-in, and failed sign-ins back off from 1 minute to 1 hour, so the account is never hammered. When Kidde's own servers fail during sign-in the backoff stops at 5 minutes, and a Retry-After from Kidde is honored.
- Alarms are recognized by serial number rather than Kidde's device id, so an alarm removed from the Kidde app and added again keeps its HomeKit accessory, room and automations. If Kidde lists the old and new record together, the live one is used. The settings page saves serial numbers in Device Settings for the same reason.
- Accessories are only removed when hidden, excluded by location, or missing from Kidde for at least 30 minutes; an empty answer from Kidde never removes anything, a Locations filter that matches nothing is ignored, and one unusual answer never removes a sensor.
- Standard Homebridge settings form with Kidde Account, HomeKit Controls, Device Settings and Advanced sections. Above it, Sign In & Find Alarms checks the credentials and lists each alarm with a Show in HomeKit switch and an editable HomeKit name, which fill in Device Settings.
- Renaming an alarm (in the Kidde app or in the settings) renames the accessory and each of its services, while running or after a restart. A name chosen in the Home app is never overwritten.
- Optional Hush and Test switches, and Identify Accessory locates the alarm.
- Self-tests, from the test button or remote, are noted in the log, including an alarm's first test (some alarms only report a test time once they have been tested). A test never triggers a HomeKit alert.
- Checked against a real Kidde account and alarm (EssWFAC smoke + CO) with `npm run probe`, a script in the repository that reads an account with the plugin's own code and writes a report with no credentials in it. The numeric fault detail fields (`flt_*_bm`) seen there are not treated as faults on their own.
- Every request to Kidde runs under one deadline covering the whole answer, oversized answers are refused, and a finished request leaves nothing behind, so memory stays flat over months of polling (checked on Node 24 and 26).
- Shutdown aborts requests in flight, so a child bridge restarts cleanly.
