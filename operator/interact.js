// A picture of a page that is the page: mouse and keyboard on the canvas go to the page itself
// (main.js → browser.js, the 'input' command), at the page's own 1920×1080 coordinates. The control
// window's monitors (operator.js) and the pop-out windows (popout.js) use it.

const PAGE_W = 1920;
const PAGE_H = 1080;

/** DOM key names → Electron's (sendInputEvent's keyCode). */
const KEYS = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Escape: 'Escape',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};
const BUTTONS = ['left', 'middle', 'right'];

/**
 * screen: the element that takes the keyboard (focusable); canvas: the picture; isOn(): whether
 * clicks and keys go to the page now; onStop(): Esc twice, to stop; send(args): one input event.
 * area(): where on screen the page is drawn ({ left, top, width, height }, as getBoundingClientRect
 * gives): the whole canvas unless it's letterboxed in it (a pop-out window's, popout.js).
 */
export function wireInteractOn({ screen, canvas, isOn, onStop, send, area = () => canvas.getBoundingClientRect() }) {
  /**
   * A point on the page (its own 1920×1080) from the mouse: null outside the picture (in a
   * letterbox's bars), or with clamp, the nearest point on its edge (a drag that strays out).
   */
  const at = (e, clamp = false) => {
    const r = area();
    let x = (e.clientX - r.left) / r.width;
    let y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      if (!clamp) return null;
      x = Math.min(1, Math.max(0, x));
      y = Math.min(1, Math.max(0, y));
    }
    return { x: x * PAGE_W, y: y * PAGE_H };
  };
  /** A button pressed on the picture: its release goes to the page wherever it happens, and moves meanwhile. */
  let pressed = false;
  const mods = (e) => [e.shiftKey && 'shift', e.ctrlKey && 'control', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean);
  canvas.addEventListener('mousedown', (e) => {
    if (!isOn()) return;
    e.preventDefault();
    screen.focus();
    const p = at(e);
    if (!p) return;
    pressed = true;
    send({ type: 'down', ...p, button: BUTTONS[e.button] ?? 'left', clickCount: e.detail || 1, modifiers: mods(e) });
  });
  canvas.addEventListener('mouseup', (e) => {
    if (!isOn() || !pressed) return;
    pressed = false;
    send({ type: 'up', ...at(e, true), button: BUTTONS[e.button] ?? 'left', clickCount: e.detail || 1, modifiers: mods(e) });
  });
  canvas.addEventListener('contextmenu', (e) => isOn() && e.preventDefault());
  // (Moves: one per frame at most, for hover menus.)
  let move = null;
  canvas.addEventListener('mousemove', (e) => {
    if (!isOn()) return;
    const p = at(e, pressed);
    if (!p) return;
    const pending = move;
    move = { type: 'move', ...p, modifiers: mods(e) };
    if (!pending)
      requestAnimationFrame(() => {
        if (move) send(move);
        move = null;
      });
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!isOn()) return;
      e.preventDefault();
      const p = at(e);
      if (!p) return;
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? PAGE_H : 1;
      send({ type: 'wheel', ...p, dx: e.deltaX * k, dy: e.deltaY * k, modifiers: mods(e) });
    },
    { passive: false },
  );
  // The window's Edit menu (Cmd+V, C, X) while interacting: the page's, not the window's. A paste is
  // the clipboard's text, typed into the page's focused field (a login's password, say).
  screen.addEventListener('paste', (e) => {
    if (!isOn()) return;
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');
    if (text) send({ type: 'paste', text });
  });
  for (const type of ['copy', 'cut'])
    screen.addEventListener(type, (e) => {
      if (!isOn()) return;
      e.preventDefault();
      send({ type });
    });
  let lastEsc = 0;
  screen.addEventListener('keydown', (e) => {
    // (Cmd+A: select all in the page.)
    if (isOn() && e.metaKey && !e.shiftKey && !e.altKey && e.code === 'KeyA') {
      e.preventDefault();
      return send({ type: 'selectAll' });
    }
    // (Cmd shortcuts stay the app's: the menus.)
    if (!isOn() || e.metaKey) return;
    // (Esc twice: stop interacting. Once: Esc for the page.)
    if (e.key === 'Escape') {
      if (Date.now() - lastEsc < 600) {
        e.preventDefault();
        return onStop();
      }
      lastEsc = Date.now();
    }
    const key = KEYS[e.key] ?? (e.key.length === 1 ? e.key : null);
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    const text = e.key.length === 1 && !e.ctrlKey ? e.key : e.key === 'Enter' ? '\r' : undefined;
    send({ type: 'key', key, text, modifiers: mods(e) });
  });
}
