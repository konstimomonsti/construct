import { useId } from 'react'

/**
 * The tower under the left end of the workflow jib, drawn in the gutter beside the content.
 * The head carries a short counter-jib (continuing the jib's web) with its counterweight and an A-frame
 * whose tie bars hold both arms; the mast runs down to the bottom of the page and stands on a footing.
 * Geometry is in px from the wrapper's top-left: the jib's top chord sits at y=17, its bottom chord at y=33,
 * and the wrapper's right edge is where the jib starts, leaving a clear gap between the mast and the content. Decorative only, so it is hidden from assistive tech.
 */
export function CraneMast() {
  const id = useId().replace(/:/g, '')
  return (
    <div aria-hidden="true" className="pointer-events-none absolute -top-4 right-full bottom-0 w-12 text-jib max-sm:hidden">
      <svg width="48" height="48" className="absolute top-0 left-0 overflow-visible" fill="none" stroke="currentColor">
        <defs>
          <pattern id={`${id}-web`} y="16" width="16" height="18" patternUnits="userSpaceOnUse">
            <path d="M0 17 L8 1 L16 17" strokeWidth="1.25" />
          </pattern>
        </defs>
        {/* tie bars from the peak to the counter-jib end and out along the jib */}
        <path d="M18 1 L1.5 17 M18 1 L170 17" strokeWidth="1" opacity="0.55" />
        {/* A-frame over the mast */}
        <path d="M11 17 L18 1 L25 17" strokeWidth="1.5" strokeLinejoin="round" />
        {/* counter-jib: same chords and web as the jib, closed at its end */}
        <rect x="1" y="16" width="47" height="18" fill={`url(#${id}-web)`} stroke="none" />
        <path d="M1 17 H48 M1 33 H48 M1 16 V34" strokeWidth="2" />
        {/* counterweight hanging under the counter-jib end */}
        <rect x="1.75" y="34.75" width="9" height="11" rx="1" fill="var(--color-brand-100)" strokeWidth="1.5" />
        <path d="M1.75 40.25 H10.75" strokeWidth="1" opacity="0.6" />
      </svg>
      {/* the mast: two chords and a zigzag web, from the jib down */}
      <svg width="14" className="absolute top-[33px] left-[11px] h-[calc(100%-38px)]" fill="none" stroke="currentColor">
        <defs>
          <pattern id={`${id}-mast`} width="14" height="16" patternUnits="userSpaceOnUse">
            <path d="M1 0 L13 8 L1 16" strokeWidth="1.25" opacity="0.7" />
          </pattern>
        </defs>
        <rect x="1" y="0" width="12" height="100%" fill={`url(#${id}-mast)`} stroke="none" />
        <line x1="1" y1="0" x2="1" y2="100%" strokeWidth="2" />
        <line x1="13" y1="0" x2="13" y2="100%" strokeWidth="2" />
      </svg>
      {/* footing */}
      <div className="absolute bottom-0 left-[5px] h-[5px] w-[26px] rounded-[1px] bg-current" />
    </div>
  )
}
