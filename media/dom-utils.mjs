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

  if (options.style !== undefined) {
    applyStyleDeclarations(element, options.style);
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

function applyStyleDeclarations(element, declarations) {
  if (declarations && typeof declarations === 'object') {
    for (const [property, value] of Object.entries(declarations)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      element.style.setProperty(toCssProperty(property), String(value));
    }
    return;
  }

  for (const declaration of String(declarations).split(';')) {
    const separator = declaration.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const property = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    if (!property || !value) {
      continue;
    }

    element.style.setProperty(property, value);
  }
}

function toCssProperty(property) {
  return property.startsWith('--')
    ? property
    : property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

export function clear(element) {
  element.replaceChildren();
}
