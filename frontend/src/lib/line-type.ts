export const LINE_TYPE_LABELS = {
  activity: 'Activity',
  material: 'Material',
  combined: 'Material & activity',
  unclassified: 'Unclassified',
} as const

export type LineType = keyof typeof LINE_TYPE_LABELS
export type LineTypeSetting = LineType | 'automatic'

export function parseLineType(value: unknown): LineTypeSetting | undefined {
  if (value === 'automatic') return value
  if (typeof value === 'string' && Object.hasOwn(LINE_TYPE_LABELS, value)) return value as LineType
}

// Match scope language rather than product names or units, which can describe any line type.
const supply = [
  /\b(?:liefern|lieferung\s+(?:von|des|der|und)|nur\s+lieferung)\b/i,
  /\b(?:supply\s+only|to\s+be\s+supplied)\b/i,
  /^\s*(?:supply|deliver|provide)(?=[\s,:])|(?:\band|&)\s*supply\b/im,
]
const work = [
  /\b(?:einbauen|einbau|montieren|montage|verlegen|verlegung|einziehen|aufstellen|auftragen|verdichten)\b/i,
  /\b(?:ausbauen|abbrechen|aufbrechen|demontieren|entsorgen|reinigen|spülen|prüfen|rückbau|abbruch)\b/i,
  /^\s*(?:install|lay|fit|remove|demolish|excavate|clean|test|repair|replace)(?=[\s,:])/im,
  /(?:\band|[&,])\s*(?:install|installation|lay|fit|test)\b/i,
  /\b(?:(?:installation|removal|demolition)\s+of|(?:installation|labor|labour)\s+only)\b/i,
]
const supplyExcluded = [
  /\b(?:ohne\s+(?:material|lieferung)|nicht\s+liefern|(?:material|lieferung)\s+bauseits|bauseits\s+geliefert\w*|beigestellt\w*)\b/i,
  /\b(?:materials?|supply)\s+(?:by\s+others|excluded|not\s+included)\b/i,
  /\b(?:supplied\s+by\s+(?:others|the\s+client)|client[- ]supplied)\b/i,
  /\b(?:(?:without|excluding|no)\s+(?:supply|materials?)|(?:installation|labor|labour)\s+only)\b/i,
]
const workExcluded = [
  /\b(?:ohne\s+(?:einbau|montage|verlegung)|nicht\s+(?:einbauen|montieren|verlegen)|nur\s+lieferung)\b/i,
  /\b(?:installation|labor|labour)\s+(?:by\s+others|excluded|not\s+included)\b/i,
  /\b(?:supply\s+only|(?:without|excluding|no)\s+installation)\b/i,
]

export function inferLineType(short: string, long?: string): LineType {
  const text = [short, long].filter(Boolean).join('\n')
  const hasSupply = supply.some((pattern) => pattern.test(text)) && !supplyExcluded.some((pattern) => pattern.test(text))
  const hasWork = work.some((pattern) => pattern.test(text)) && !workExcluded.some((pattern) => pattern.test(text))
  if (hasSupply && hasWork) return 'combined'
  if (hasSupply) return 'material'
  if (hasWork) return 'activity'
  return 'unclassified'
}

export function lineTypeOf({ lineType, short, long }: { lineType?: LineTypeSetting; short: string; long?: string }, suggestion?: LineType): LineType {
  return lineType && lineType !== 'automatic' ? lineType : suggestion ?? inferLineType(short, long)
}
