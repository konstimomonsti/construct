/** Read tender files with the workspace picker parser for backend evaluation. */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { parseListFile } from '../src/lib/parse-list-file'

Object.assign(globalThis, { DOMParser })

for (const path of process.argv.slice(2)) {
  if (path.endsWith('.labels.json')) continue
  const file = new File([await readFile(path)], basename(path))
  const parsed = await parseListFile(file)
  if (!parsed) throw new Error(`No positions in ${path}`)
  console.log(JSON.stringify({ path, document: { ...parsed, fileName: file.name } }))
}
