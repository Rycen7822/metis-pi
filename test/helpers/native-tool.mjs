import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

// Inherit the real host; copy only intercepted descriptors to give each test its own lease.
export function isolatedToolHost() {
  class Host extends ToolExecutionComponent {
    constructor(name, definition = {}, args = {}) {
      super(name, "native-test", args, { showImages: false }, definition,
        { requestRender() {} }, process.cwd());
      this.markExecutionStarted();
    }
  }
  for (const key of ["getCallRenderer", "getResultRenderer", "getRenderShell", "render"]) {
    Object.defineProperty(Host.prototype, key, Object.getOwnPropertyDescriptor(ToolExecutionComponent.prototype, key));
  }
  return Host;
}
