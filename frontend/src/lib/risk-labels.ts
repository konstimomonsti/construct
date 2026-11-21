export function partialAnalysis(errors: string[]) {
  const details: string[] = []
  let skipped = 0
  let failed = false
  for (const error of errors) {
    const coverage = /^layer 3 coverage: (\d+)\/(\d+) batches\b/i.exec(error)
    if (coverage) {
      skipped = Math.max(skipped, Number(coverage[2]) - Number(coverage[1]))
      details.push(error)
    } else if (/^(?:layer 3(?: audit model)?:|L3\.)/i.test(error)) {
      failed = true
      details.push(error)
    }
  }
  if (!skipped && !failed) return null
  return {
    message: skipped > 0
      ? `${skipped} AI ${skipped === 1 ? 'batch was' : 'batches were'} skipped.`
      : 'One or more AI checks could not finish.',
    details,
  }
}

export type PartialAnalysis = ReturnType<typeof partialAnalysis>
