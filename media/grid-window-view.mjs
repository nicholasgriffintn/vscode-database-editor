import { createElement } from './utilities/dom.mjs';

export function createGridWindowSpacer({ columnCount, height }) {
  return createElement('tr', {
    className: 'grid-window-spacer',
    attributes: { 'aria-hidden': 'true' },
    children: [createElement('td', {
      attributes: { colspan: String(columnCount) },
      style: { height: `${height}px` },
    })],
  });
}
