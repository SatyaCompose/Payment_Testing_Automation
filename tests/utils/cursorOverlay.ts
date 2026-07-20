/**
 * Injects a floating red cursor into every page so operators watching the
 * headed browser can see exactly what the script is pointing at / clicking.
 *
 * Playwright fires real DOM mouse events (mousemove, mousedown, mouseup,
 * click) during its actions, so a mousemove listener catches them all.
 * The cursor pulses briefly on click for extra visibility.
 */
export const CURSOR_OVERLAY_SCRIPT = `
(() => {
  // Don't install inside iframes — otherwise the payment page's
  // Cybersource / PayPal / Google Pay iframes each get their own red
  // cursor, and the composite screenshot shows several stacked circles.
  if (window !== window.top) return;
  if (window.__pwCursorInstalled) return;
  window.__pwCursorInstalled = true;

  const install = () => {
    if (!document.body || document.getElementById('__pw_cursor__')) return;
    const cursor = document.createElement('div');
    cursor.id = '__pw_cursor__';
    cursor.style.cssText = [
      'position: fixed',
      'top: -100px',
      'left: -100px',
      'width: 22px',
      'height: 22px',
      'background: rgba(255, 60, 60, 0.35)',
      'border: 3px solid rgba(255, 30, 30, 0.95)',
      'border-radius: 50%',
      'pointer-events: none',
      'z-index: 2147483647',
      'transform: translate(-50%, -50%)',
      'transition: transform 60ms ease-out, background-color 120ms',
      'box-shadow: 0 0 12px rgba(255, 0, 0, 0.55)',
    ].join(';');
    document.documentElement.appendChild(cursor);

    const label = document.createElement('div');
    label.id = '__pw_cursor_label__';
    label.style.cssText = [
      'position: fixed',
      'top: -100px',
      'left: -100px',
      'padding: 2px 8px',
      'background: rgba(15, 23, 42, 0.9)',
      'color: #fff',
      'font: 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'border-radius: 4px',
      'pointer-events: none',
      'z-index: 2147483647',
      'transform: translate(12px, 12px)',
      'transition: opacity 120ms',
      'opacity: 0',
    ].join(';');
    document.documentElement.appendChild(label);

    const moveTo = (x, y) => {
      cursor.style.left = x + 'px';
      cursor.style.top = y + 'px';
      label.style.left = x + 'px';
      label.style.top = y + 'px';
    };

    document.addEventListener('mousemove', (e) => moveTo(e.clientX, e.clientY), true);
    document.addEventListener(
      'mousedown',
      (e) => {
        moveTo(e.clientX, e.clientY);
        cursor.style.transform = 'translate(-50%, -50%) scale(1.6)';
        cursor.style.background = 'rgba(255, 220, 60, 0.7)';
        label.style.opacity = '1';
        const tgt = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '?';
        const txt = (e.target && e.target.textContent ? e.target.textContent : '').trim().slice(0, 30);
        label.textContent = tgt + (txt ? ': ' + txt : '');
      },
      true,
    );
    document.addEventListener(
      'mouseup',
      () => {
        cursor.style.transform = 'translate(-50%, -50%) scale(1)';
        cursor.style.background = 'rgba(255, 60, 60, 0.35)';
        setTimeout(() => (label.style.opacity = '0'), 600);
      },
      true,
    );
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
`;
