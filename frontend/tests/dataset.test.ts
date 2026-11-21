import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { extname, basename, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DOMParser } from '@xmldom/xmldom'
import { decodeGaeb90 } from '../src/lib/gaeb'
import { parseListFile } from '../src/lib/parse-list-file'

Object.assign(globalThis, { DOMParser })

const root = fileURLToPath(new URL('../..', import.meta.url))
const metadata = new Set(['README.md', 'MANIFEST.sha256', '.gitattributes'])
const unsupported = new Set(['.p86', '.x83z', '.x84z', '.x86ze', '.x86zr'])
const dataset = []
for (const name of ['data/tenders', 'data/fixtures']) {
  const dir = join(root, name)
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  dataset.push(...entries.filter((entry) => entry.isFile() && !metadata.has(entry.name))
    .map((entry) => join(entry.parentPath, entry.name)))
}

for (const path of dataset.sort()) {
  test(relative(root, path), async () => {
    const bytes = new Uint8Array(await readFile(path))
    const file = new File([bytes], basename(path))
    const extension = extname(path).toLowerCase()

    if (unsupported.has(extension)) {
      await assert.rejects(parseListFile(file), /Unsupported file type/)
      return
    }

    const list = await parseListFile(file)
    if (extension === '.pdf' || extension === '.docx') {
      // The workspace attaches ordinary documents. The backend corpus suite checks their extraction.
      assert.equal(list, undefined)
      return
    }

    assert.ok(list)
    assert.equal(list.phase?.toLowerCase(), extension.slice(1))
    assert.ok(list.positions.length)
    assert.ok(list.positions.every((item) => item.oz && Number.isFinite(item.qty) && (item.up === null || Number.isFinite(item.up))))
    if (extension.startsWith('.x')) {
      const source = new DOMParser().parseFromString(await file.text(), 'application/xml')
      assert.equal(list.positions.length, source.getElementsByTagNameNS('*', 'Item').length)
    } else {
      const records = decodeGaeb90(bytes).split(/\r\n|\n|\r/)
      const positions = records.filter((record) => record.startsWith('21'))
      const codes = new Set(positions.map((record) => record.slice(2, 11)))
      const priceOnly = new Set(records.filter((record) => /^(22|23)/.test(record) && !codes.has(record.slice(2, 11)))
        .map((record) => record.slice(2, 11)))
      assert.equal(list.positions.length, positions.length + priceOnly.size)
    }
  })
}
