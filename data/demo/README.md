# BillBuild presenter files

Both files are generated GAEB X83 tenders. They contain deliberately damaged synthetic scope and pricing data.

| File and position | Planted issue | Expected assessment |
| --- | --- | --- |
| `building_hall_planted.X83`, `02.01.0020` | Edge insulation removed | Layer 2 flags the dependent screed scope at `02.02.0010` and `02.02.0020`. |
| Building hall, `01.04.0035` | Copy of `01.04.0030` under a new OZ | Layer 1 flags a possible duplicate. |
| Building hall, `05.02.0040` | Priced line has zero quantity | Layer 1 flags the quantity. |
| Building hall, `01.02.0010` | Amount changed from €12,420.00 to €12,792.60 | The CLI identifies the wrong line amount and its subtotal and net consequences. The current X83 upload check omits the source amount. |
| `precast_lv11_planted.X83`, `3.2.20` | C20/25 with XF4 | Expected exposure-strength finding from Task 01. |
| Precast, `3.2.30` | Insulation changed to 10 cm, bringing layers to 32 cm against a stated total of 30 cm | Expected layer-sum finding from Task 01. |
| Precast, `3.2.80` | Surcharge unit changed to metres while the description says billing by piece | Layer 1 flags the billing-unit conflict today. The additional trade-specific unit rule belongs to Task 01. |
| Precast, `3.2.90` | Embedded product type replaced by a placeholder | Expected specification-placeholder finding from Task 01. |
| Precast, `3.2.40` | Height and colour specification removed from a through-coloured element | Expected specification finding from Task 02 when Layer 3 runs. |

## Three-minute walkthrough

1. **0:00–0:35.** Drop the building hall X83 into a project folder and open the list. Wait for the upload assessment and show the flagged positions.
2. **0:35–1:35.** Open the zero-quantity finding and the possible duplicate, then verify the linked position. Use the CLI report to show the written and calculated amount for `01.02.0010`. Show the screed dependency and use the scope and proposed fix to explain what a reviewer needs to check before making a change.
3. **1:35–2:35.** Import the precast X83. Open the proven billing-unit mismatch at `3.2.80`. Present the DIN, sandwich and Layer 3 cases according to the rule versions deployed on the demo stack.
4. **2:35–3:00.** Show the generated Markdown results. Explain the difference between a catch, a known gap, and a layer that did not run. Mention that both synthetic seeds and the harmless controls were clean on the deterministic replay.

The [evaluation guide](../../docs/EVALUATION.md) has the regeneration and reporting commands.
