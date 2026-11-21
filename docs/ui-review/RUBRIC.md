# BillBuild UI council — rubric

Product: BillBuild, a budget workspace for construction tenders (German GAEB bills of quantities).
Users are estimators / project managers who open tender lists (LV), adjust quantities and unit prices,
and watch each list's total against a budget cap. UI chrome is English; content is German and must stay verbatim
(placeholders such as `[PERSON_132]` are anonymised source data, not bugs).

Benchmark: the Wise (TransferWise) web dashboard. What Wise does well:
- One hero number per screen (total balance) set very large, with 2-3 pill actions right under it; one is primary.
- Calm chrome: a slim left nav with ~5 items, no section headers, no fake widgets; top bar holds little more than the account.
- Lists, not tables: activity rows with a round icon, bold title, muted subtitle, amount right-aligned; generous row height, hairline or no dividers.
- Borderless soft surfaces (subtle fills, large radii) instead of boxes-in-boxes; few dividers.
- Proportional tabular figures for money (no monospace), clear sign/colour for status.
- Progressive disclosure: secondary actions sit in a "more" menu; the screen never shows the same action twice.
- Mobile is first-class: the same hierarchy stacks cleanly, nothing scrolls sideways.
Our goal is to be BETTER than that for this domain: as calm as Wise, but with denser-when-needed data editing for estimators.

## Categories (score each 0-10, integers)
1. **Hierarchy & focus** — a single obvious focal point and primary action; the eye knows where to go.
2. **Density & breathing room** — not crowded; whitespace groups things; no boxes-in-boxes; nothing redundant on screen.
3. **Typography & numbers** — type scale, weights, legible money/quantities (tabular, proportional), consistent casing.
4. **Consistency & craft** — same components/spacing/radii/icons everywhere; alignment; polish; no duplicate or dead controls.
5. **Clarity of content** — labels plain and meaningful, status understandable at a glance, no jargon/noise/demo controls.
6. **Interaction & affordance** — actions discoverable at the right place, clickable things look clickable, states (hover/selected/empty) clear.
7. **Accessibility** — contrast (WCAG AA), target sizes, focus/labels visible, not colour-only status.
8. **Responsive** — mobile screenshots (11, 12) and desktop layout hold up; nothing overflows or is cramped. For desktop-only screens, judge how well the layout would adapt given what you see.
9. **Wise benchmark** — does it feel as calm and premium as Wise's dashboard (or better)? 10 = clearly better than Wise for this job.

Scoring calibration: 9 = excellent, a demanding senior designer would ship it with at most nitpicks. 7 = decent but with clear issues. 5 = mediocre/crowded. Be strict; do not inflate.
