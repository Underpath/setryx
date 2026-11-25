import { type PointerEvent as ReactPointerEvent, useRef } from 'react';

/**
 * Minimal drag-to-reorder for a list of elements marked with data-sort-key.
 * Works with mouse, touch and pen, and with rows of different heights or a
 * two-column grid: the drop target is the item whose centre is nearest.
 */
export function useSortable(onMove: (from: number, to: number) => void) {
  const container = useRef<HTMLElement | null>(null);
  const state = useRef<{ index: number; pointerId: number } | null>(null);

  const items = () => (container.current ? Array.from(container.current.querySelectorAll<HTMLElement>(':scope > [data-sort-key]')) : []);

  const onPointerMove = (e: PointerEvent) => {
    const s = state.current;
    if (!s || e.pointerId !== s.pointerId) return;
    e.preventDefault();
    let best = s.index;
    let bestDist = Infinity;
    items().forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    if (best !== s.index) {
      onMove(s.index, best);
      s.index = best;
    }
  };

  const end = () => {
    items().forEach((el) => el.classList.remove('dragging'));
    state.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
  };

  /** Spread onto the drag handle of item `index`. */
  const handle = (index: number) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      state.current = { index, pointerId: e.pointerId };
      items()[index]?.classList.add('dragging');
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    },
  });

  return { ref: container, handle };
}

export function move<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it!);
  return next;
}
