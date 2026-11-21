# BillBuild presenter files

Both files are generated GAEB X83 tenders. They contain deliberately damaged synthetic scope and pricing data.

| File and position | Planted issue | Expected assessment |
| --- | --- | --- |
| `building_hall_planted.X83`, `02.01.0020` | Edge insulation removed | Layer 2 flags the dependent screed scope at `02.02.0010` and `02.02.0020`. |
| Building hall, `03.01.0035` | Copy of `03.01.0030` under a new OZ | Layer 1 flags a possible duplicate. |
| Building hall, `05.02.0050` | Priced line has zero quantity | Layer 1 flags the quantity. |
| Building hall, `01.02.0010` | Amount changed from €12,420.00 to €12,792.60 | The upload assessment flags the written line amount, the section subtotal and the net total. |
| `precast_lv11_planted.X83`, `3.2.20` | C20/25 with XF4 | Layer 1 flags the exposure-strength conflict. |
| Precast, `3.2.30` | Insulation changed to 10 cm, bringing layers to 32 cm against a stated total of 30 cm | Layer 1 flags the 2 cm discrepancy. |
| Precast, `3.2.80` | Surcharge unit changed to metres while the description says billing by piece | Layer 1 flags both the stated billing-unit conflict and the unusual unit for a surcharge. |
| Precast, `3.2.90` | Embedded product type replaced by a placeholder | Layer 1 flags the specification placeholder. |
| Precast, `3.2.40` | Height and colour specification removed from a through-coloured element | Expected specification finding from Task 02 when Layer 3 runs. |

## Three-minute walkthrough

1. **0:00–0:35.** Drop the building hall X83 into a project folder. The list opens and shows the status of the upload assessment.
2. **0:35–1:35.** Open the finding on `01.02.0010` and compare the written and calculated amounts. Review the missing edge insulation, expand the **client clarification draft** on the finding, and copy the German email draft.
3. **1:35–2:35.** Import the precast X83. Open the proven billing-unit mismatch at `3.2.80`. Show the concrete class, sandwich layer thicknesses, and placeholder findings. Show the missing-specification case if Layer 3 is available.
4. **2:35–3:00.** Show the generated Markdown results. Explain the difference between a catch, a known gap, and a layer that did not run. Mention that both synthetic seeds and the harmless controls were clean on the deterministic replay.

The [evaluation guide](../../docs/EVALUATION.md) has the regeneration and reporting commands.
