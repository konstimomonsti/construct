/** Read tender files with the workspace picker parser for backend evaluation. */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseListFile } from '../src/lib/parse-list-file'

for (const path of process.argv.slice(2)) {
  const file = new File([await readFile(path)], basename(path))
  const parsed = await parseListFile(file)
  if (!parsed) throw new Error(`No positions in ${path}`)
  console.log(JSON.stringify({ path, document: { ...parsed, fileName: file.name } }))
}
