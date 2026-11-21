# BillBuild UI council — rubric

Product: BillBuild, a budget workspace for construction tenders (German GAEB bills of quantities).
Users are estimators / project managers who open tender lists (LV), adjust quantities and unit prices,
and watch each list's total against a budget cap. UI chrome is English; content is German and must stay verbatim
(placeholders such as `[PERSON_132]` are anonymised source data, not bugs).

Design brief (current direction, set by the product owner):
- **Palette is fixed**, taken from the "AI Under Construction" hackathon poster: pit black `#0d0502`, hoarding brown `#1a0c01`,
  cool blue-black `#0d0e17`, bronze `#523a0f`, signal yellow `#edb03e`. Dark only. Judge how well the palette is used, not whether to use it.
- **Theo test**: Theo Browne (t3.gg) should love it. That means dark, crisp and fast-feeling; keyboard-first (⌘K visible and useful);
  dense but clean; no fluff, no decorative gradients or glassy shadows; small radii; type with character; every element earns its place.
- **Wise benchmark** still applies for money UI: one hero number per screen, calm list rows, status by colour AND word,
  progressive disclosure, first-class mobile. Our goal is to beat Wise for this job.
- One bold element: the hero meter is drawn as a crane jib (truss) with a hook at the current spend. Everything else should stay quiet.

## Categories (score each 0-10, integers)
1. **Hierarchy & focus** — a single obvious focal point and primary action; the eye knows where to go.
2. **Density & breathing room** — not crowded; whitespace groups things; no boxes-in-boxes; nothing redundant on screen.
3. **Typography & numbers** — type scale, weights, legible money/quantities (tabular, proportional), consistent casing.
4. **Consistency & craft** — same components/spacing/radii/icons everywhere; alignment; polish; no duplicate or dead controls.
5. **Clarity of content** — labels plain and meaningful, status understandable at a glance, no jargon/noise/demo controls.
6. **Interaction & affordance** — actions discoverable at the right place, clickable things look clickable, states (hover/selected/empty) clear.
7. **Accessibility** — contrast (WCAG AA), target sizes, focus/labels visible, not colour-only status.
8. **Responsive** — mobile screenshots (11, 12) and desktop layout hold up; nothing overflows or is cramped. For desktop-only screens, judge how well the layout would adapt given what you see.
9. **Benchmark (Wise + Theo)** — as calm and trustworthy as Wise's money UI, AND something Theo would screenshot and praise (dark, crisp, keyboard-first, opinionated). 10 = clearly better than Wise for this job and Theo would love it.

Scoring calibration: 9 = excellent, a demanding senior designer would ship it with at most nitpicks. 7 = decent but with clear issues. 5 = mediocre/crowded. Be strict; do not inflate.
