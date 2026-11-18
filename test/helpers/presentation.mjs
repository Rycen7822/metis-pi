// Data and text primitives shared by tests; real host contracts use Pi components.
export const theme = { fg: (_key, text) => text, bold: (text) => text };

export class FakeText {
  constructor(text) { this.text = text; }
  setText(text) { this.text = text; }
  render(_width) { return this.text ? this.text.split("\n") : []; }
  invalidate() {}
}
export const bindings = { makeText: (s) => new FakeText(s), expandHint: () => "ctrl+o to expand" };
/** Session stub with a fixed truecolor capability (Codex reference env). */
export function presentationSession() {
  return { colorLevel: { kind: "truecolor" }, writeChanges: new Map() };
}
export function toolInfo(name, builtin = true) {
  return { name, sourceInfo: { source: builtin ? "builtin" : "npm:other-extension",
    path: builtin ? `builtin:${name}` : `/extensions/${name}.ts` } };
}
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
