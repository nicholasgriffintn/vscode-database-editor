export function createClipboardBridge({ vscode, timeoutMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let requestCounter = 0;
  const pendingReads = new Map();

  function writeText(text) {
    vscode.postMessage({ type: 'clipboardWrite', text });
  }

  function readText() {
    const requestId = String(++requestCounter);
    vscode.postMessage({ type: 'clipboardRead', requestId });
    return new Promise((resolve) => {
      const timeout = setTimer(() => {
        pendingReads.delete(requestId);
        resolve('');
      }, timeoutMs);
      pendingReads.set(requestId, {
        resolve: (text) => {
          clearTimer(timeout);
          resolve(text);
        },
      });
    });
  }

  function handleMessage({ requestId, text }) {
    const pending = pendingReads.get(requestId);
    if (!pending) return false;
    pendingReads.delete(requestId);
    pending.resolve(text ?? '');
    return true;
  }

  return { handleMessage, readText, writeText };
}
