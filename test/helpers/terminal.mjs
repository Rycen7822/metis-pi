// Terminal input and recording; not dependent on Pi rendering.
export function fakeTerminal(columns, rows = 24) {
  const writes = [];
  return { columns, rows, write: (text) => writes.push(text), writes };
}

/** One-based terminal coordinates, including mouse release events. */
export function sgr(button, x, y, release = false) {
  return `\x1b[<${button};${x};${y}${release ? "m" : "M"}`;
}
