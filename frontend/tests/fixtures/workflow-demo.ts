/**
 * DEMO DATA — not real subcontractors, offers or prices.
 * Loaded read-only by `?demo=workflow` on the list page (`angebot-an24-0305-d84`); never written to the store.
 * Position ids (p0…) are the real ids of frontend/public/data/lists/angebot-an24-0305-d84.json.
 */
import type { SubcontractPackage } from '../../src/lib/subcontract'

export const demoPackages: SubcontractPackage[] = [
  {
    id: 'demo-kitchen',
    name: 'Kitchen',
    positionIds: ['p0', 'p1', 'p2', 'p3', 'p4'],
    subcontractorIds: ['demo-s1', 'demo-s2', 'demo-s3', 'demo-s4'],
    budget: { perPosition: {}, total: 10000 },
    dueDate: '2026-12-05',
    format: 'x83',
    status: 'offer_received',
    sentAt: '2026-11-10T09:00:00.000Z',
    chosenId: 'demo-s2',
    offers: {
      'demo-s1': { receivedAt: '2026-11-14T10:00:00.000Z', amount: 10800, note: 'Valid until 31.12., excl. delivery', fileName: 'angebot-kuechen-nord.x84', matched: 5, missing: [] },
      'demo-s2': { receivedAt: '2026-11-15T08:30:00.000Z', amount: 9400, note: 'Two weeks lead time', fileName: 'angebot-schmidt.x84', matched: 4, missing: ['p4'] },
      'demo-s3': { sentAt: '2026-11-11T09:00:00.000Z' },
      'demo-s4': { receivedAt: '2026-11-18T13:00:00.000Z', amount: 12100, declined: true, note: 'Declined: over budget' },
    },
  },
  {
    id: 'demo-trench',
    name: 'Rohrgraben',
    positionIds: ['p5', 'p6', 'p7', 'p8', 'p9'],
    subcontractorIds: ['demo-s5', 'demo-s6', 'demo-s7'],
    budget: { perPosition: {}, total: 24000 },
    dueDate: '2026-12-12',
    format: 'xlsx',
    status: 'sent',
    sentAt: '2026-11-12T09:00:00.000Z',
    offers: {
      'demo-s5': { receivedAt: '2026-11-19T09:00:00.000Z', amount: 26000, note: 'By email, no file' },
      'demo-s6': {},
      'demo-s7': { sentAt: '2026-11-13T09:00:00.000Z' },
    },
  },
]

/** catalogue id → display data, standing in for the subcontractor catalogue the backend serves */
export const demoNames: Record<string, { name: string; trade: string }> = {
  'demo-s1': { name: 'Küchen Nord GmbH', trade: 'Küchenbau' },
  'demo-s2': { name: 'Schmidt Ausbau', trade: 'Küchenbau' },
  'demo-s3': { name: 'Meier & Söhne', trade: 'Tischlerei' },
  'demo-s4': { name: 'Interior Plus', trade: 'Innenausbau' },
  'demo-s5': { name: 'Tiefbau Krause', trade: 'Tiefbau' },
  'demo-s6': { name: 'Rohrleitungsbau Weber', trade: 'Tiefbau' },
  'demo-s7': { name: 'Erdbau Hoffmann', trade: 'Erdbau' },
}
