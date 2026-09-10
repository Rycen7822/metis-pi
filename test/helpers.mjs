// Minimal, explicit layout harness, NOT an installed Pi host.
// The selector/self-shell layout contract is based on Pi v0.85.1 (MIT).
export const theme = { fg: (_key, text) => text, bold: (text) => text };
export class FakeText {
  constructor(text) { this.text = text; }
  setText(text) { this.text = text; }
  render(_width) { return this.text ? this.text.split("\n") : []; }
}
export const bindings = { makeText: (s) => new FakeText(s), expandHint: () => "ctrl+o to expand" };
/** Session stub with a fixed truecolor capability (Codex reference env). */
export const sessionStub = {
  tracker: { trackStart() {}, trackEnd() {} },
  colorLevel: { kind: "truecolor" },
  writeChanges: new Map(),
};
class FakeContainer {
  children = [];
  addChild(child) { this.children.push(child); }
  clear() { this.children.length = 0; }
  render(width) { return this.children.flatMap((c) => c?.render ? c.render(width) : String(c ?? "").split("\n")); }
}
class FakeBox extends FakeContainer {
  render(width) { return ["[BOX TOP]", ...super.render(width).map((s) => ` ${s} `), "[BOX BOTTOM]"]; }
}
export function fakeHost() {
  return class FakeToolExecutionComponent extends FakeContainer {
    constructor(name, definition = {}, args = {}) {
      super();
      this.toolName = name; this.toolDefinition = definition; this.args = args;
      this.isPartial = true; this.expanded = false; this.showImages = false;
      this.rendererState = {}; this.imageComponents = []; this.imageSpacers = [];
      this.selfRenderHeight = 0; this.hideComponent = false; this.refreshes = 0;
      this.ui = { requestRender() {} };
      this.contentBox = new FakeBox();
      this.selfRenderContainer = new FakeContainer();
      this.addChild(new FakeText("\n"));
      this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
      this.updateDisplay();
    }
    getCallRenderer() { return this.toolDefinition?.renderCall; }
    getResultRenderer() { return this.toolDefinition?.renderResult; }
    getRenderShell() { return this.toolDefinition?.renderShell ?? "default"; }
    getContext(lastComponent) {
      return { args: this.args, state: this.rendererState, lastComponent,
        isPartial: this.isPartial, isError: this.result?.isError ?? false,
        showImages: this.showImages, expanded: this.expanded };
    }
    updateDisplay() {
      this.refreshes++;
      const target = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
      target.clear();
      const call = this.getCallRenderer();
      this.callRendererComponent = call?.(this.args, theme, this.getContext(this.callRendererComponent)) ?? new FakeText("NATIVE");
      target.addChild(this.callRendererComponent);
      if (this.result) {
        const render = this.getResultRenderer();
        this.resultRendererComponent = render?.(this.result, { expanded: this.expanded, isPartial: this.isPartial }, theme,
          this.getContext(this.resultRendererComponent)) ?? new FakeText("NATIVE RESULT");
        target.addChild(this.resultRendererComponent);
      }
    }
    updateResult(result, isPartial = false) { this.result = result; this.isPartial = isPartial; this.updateDisplay(); }
    setExpanded(value) { this.expanded = value; this.updateDisplay(); }
    render(width) {
      if (this.hideComponent) return [];
      if (this.getRenderShell() === "self") {
        const contentLines = this.selfRenderContainer.render(width);
        this.selfRenderHeight = contentLines.length;
        if (contentLines.length === 0 && this.imageComponents.length === 0) return [];
        const lines = contentLines.length ? ["", ...contentLines] : [];
        for (let i = 0; i < this.imageComponents.length; i++) {
          if (this.imageSpacers[i]) lines.push(...this.imageSpacers[i].render(width));
          lines.push(...this.imageComponents[i].render(width));
        }
        return lines;
      }
      return super.render(width);
    }
  };
}
export function toolInfo(name, builtin = true) {
  return { name, sourceInfo: { source: builtin ? "builtin" : "npm:other-extension",
    path: builtin ? `<builtin:${name}>` : `/extensions/${name}.ts` } };
}
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
