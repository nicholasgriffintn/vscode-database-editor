import assert from 'node:assert/strict';
import test from 'node:test';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.title = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  replaceChildren(...children) {
    this.children = children;
  }
}

globalThis.document = {
  createElement(tagName) {
    return new FakeElement(tagName);
  },
};

const { createElement } = await import('../media/dom-utils.mjs');

test('createElement applies inline styles passed through options', () => {
  const element = createElement('td', {
    className: 'pinned',
    style: 'width:80px;left:52px;z-index:5',
    attributes: { 'data-column': 'id' },
  });

  assert.equal(element.className, 'pinned');
  assert.equal(element.attributes.get('style'), 'width:80px;left:52px;z-index:5');
  assert.equal(element.attributes.get('data-column'), 'id');
});
