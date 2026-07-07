export function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);

  if (options.className) {
    element.className = options.className;
  }

  if (options.text !== undefined) {
    element.textContent = options.text;
  }

  if (options.title) {
    element.title = options.title;
  }

  if (options.attributes) {
    for (const [name, value] of Object.entries(options.attributes)) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      element.setAttribute(name, String(value));
    }
  }

  if (options.children) {
    element.replaceChildren(...options.children);
  }

  return element;
}

export function clear(element) {
  element.replaceChildren();
}
