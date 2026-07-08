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
    this.style = {
      declarations: new Map(),
      setProperty: (property, value) => {
        this.style.declarations.set(property, value);
      },
    };
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

test('createElement applies style declarations without setting a style attribute', () => {
  const element = createElement('td', {
    className: 'pinned',
    style: 'width:80px;left:52px;z-index:5',
    attributes: { 'data-column': 'id' },
  });

  assert.equal(element.className, 'pinned');
  assert.equal(element.attributes.has('style'), false);
  assert.equal(element.style.declarations.get('width'), '80px');
  assert.equal(element.style.declarations.get('left'), '52px');
  assert.equal(element.style.declarations.get('z-index'), '5');
  assert.equal(element.attributes.get('data-column'), 'id');
});
