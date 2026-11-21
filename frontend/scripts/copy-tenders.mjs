import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'

const source = new URL('../../data/tenders/', import.meta.url)
const destination = new URL('../public/files/', import.meta.url)
mkdirSync(destination, { recursive: true })

for (const file of readdirSync(source)) {
  if (file.startsWith('.')) continue
  const name = encodeURIComponent(file)
  copyFileSync(new URL(name, source), new URL(name, destination))
}
