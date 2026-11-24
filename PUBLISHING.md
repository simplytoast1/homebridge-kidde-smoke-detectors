# Publishing and Verification

Steps to publish `homebridge-kidde-smoke-detectors` to npm and get it **Verified by Homebridge**.

## 1. GitHub repository

1. Create `simplytoast1/homebridge-kidde-smoke-detectors` on GitHub.
2. Make sure **Issues are enabled** (Settings > General > Features). Verification requires it.
3. Push the code:
   ```bash
   git init
   git add .
   git commit -m "Initial release"
   git branch -M main
   git remote add origin https://github.com/simplytoast1/homebridge-kidde-smoke-detectors.git
   git push -u origin main
   ```
4. Add an `NPM_TOKEN` secret (Settings > Secrets and variables > Actions) holding an npm **automation** token, so the CI workflow can publish.

CI (`.github/workflows/ci.yml`) typechecks and runs the test suite on Node 22, 24 and 26 for every push and pull request.

## 2. Release a version

Every version on npm needs a matching **GitHub Release with notes**. The Homebridge UI shows those notes, and verification expects them.

1. Update `CHANGELOG.md` (replace "unreleased" with the date).
2. Bump the version, which also creates the `v` tag:
   ```bash
   npm version patch   # or minor / major
   git push && git push --tags
   ```
3. Create the GitHub Release from the tag, pasting that version's changelog section:
   ```bash
   gh release create v1.0.0 --title "v1.0.0" --notes-file release-notes.md
   ```
4. Publishing the release triggers CI, which tests and then runs `npm publish --provenance`.

Version 1.0.0 was published by hand (`npm login`, then `npm publish --access public`) before its GitHub release. The publish job skips any version already on npm, so a release made after a manual publish still passes. From then on, add the `NPM_TOKEN` secret and let releases publish.

## 3. Check it installs

```bash
npm view homebridge-kidde-smoke-detectors
```

Then install it from the Homebridge UI on a test system, configure it, and confirm the alarms appear and the log is clean.

## 4. Request verification

Verification now lives in the [homebridge/plugins](https://github.com/homebridge/plugins) repository. Open a new issue there with the **Plugin Verification Request** template:

- Plugin name: `homebridge-kidde-smoke-detectors`
- GitHub repo: `https://github.com/simplytoast1/homebridge-kidde-smoke-detectors`
- Icon (optional): a square PNG, around 100 x 100 px, that does not use Kidde's logo

How this plugin meets each requirement (current as of the 2026-11-01 list):

| Requirement | How it is met |
|---|---|
| Dynamic platform | `KiddeSmokeDetectorsPlatform` implements `DynamicPlatformPlugin` |
| Not the same or less functionality than an existing verified plugin | No Kidde HomeSafe plugin is verified |
| On npm, source on GitHub with issues enabled | See steps 1 and 2 |
| GitHub release with notes for every version | See step 2 |
| Runs on Node 22, 24 and 26 | `engines.node` is `^22.10.0 \|\| ^24.0.0 \|\| ^26.0.0`; CI tests all three |
| Installs, and does not start unless configured | Without an email and password it logs "Not set up yet" and makes no network requests (covered by a test) |
| No post-install scripts | `package.json` has none |
| No TTY or special startup parameters | Configured entirely in the Homebridge UI |
| Implements the Plugin Settings GUI | `config.schema.json` (standard form) with a custom panel above it |
| No analytics or tracking | Only `api.homesafe.kidde.com` is contacted |
| Files only in the Homebridge storage directory | The session and device-list files are written to `api.user.storagePath()` |
| Catches and logs its own errors | Polling, commands, timers and settings-page requests all catch and log; covered by tests including malformed data and outages |

## Quick reference

| Task | Command |
|---|---|
| Install dependencies | `npm install` |
| Build | `npm run build` |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Preview the npm package contents | `npm pack --dry-run` |
| Bump version | `npm version patch` |
