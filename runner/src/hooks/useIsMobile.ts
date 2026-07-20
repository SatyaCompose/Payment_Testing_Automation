import { useEffect, useState } from 'react';

/**
 * `true` when the viewport is narrower than the breakpoint (default 768px)
 * OR the user-agent looks mobile. Re-evaluates on resize + orientation.
 */
export function useIsMobile(breakpointPx = 768): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => detect(breakpointPx));

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    const update = () => setIsMobile(detect(breakpointPx));
    mq.addEventListener?.('change', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      mq.removeEventListener?.('change', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [breakpointPx]);

  return isMobile;
}

function detect(breakpointPx: number): boolean {
  if (typeof window === 'undefined') return false;
  const narrow = window.innerWidth < breakpointPx;
  const uaMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent);
  return narrow || uaMobile;
}
