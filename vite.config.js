import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Build-ID für den Versionshinweis (Resilience F8, src/lib/versionCheck.js): auf Vercel der Commit des Deployments,
// lokal der aktuelle Commit (so bleibt ein lokaler Build desselben Commits byte-gleich zum Live-Build). Ohne Git → 'dev'
// (Versionsprüfung aus). Dieselbe ID steht im Bundle und in /version.json.
function buildId() {
  const env = process.env.VERCEL_GIT_COMMIT_SHA
  if (env && /^[0-9a-f]{7,40}$/i.test(env)) return env.toLowerCase()
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().toLowerCase() } catch { return 'dev' }
}
const BUILD_ID = buildId()

const versionFile = () => ({
  name: 'cafe-version-file',
  apply: 'build',
  generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) + '\n' }) },
})

export default defineConfig({
  plugins: [react(), versionFile()],
  define: { __APP_BUILD_ID__: JSON.stringify(BUILD_ID) },
})
