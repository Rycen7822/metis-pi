import {
  copySourceFor, publishRows, publishedRowsOf, registerCacheReleaser, registerProduct, type ChildPlacement, type CopySource,
} from "./model.ts";

type Rows = readonly string[];
interface ChildLayout {
  width: number;
  children: readonly object[];
  parts: readonly Rows[];
}
interface ContainerLike { childLines?: ChildLayout }
interface BoxLike extends ContainerLike { paddingX: number; paddingY: number }
type Render<Self> = (this: Self, width: number) => Rows;

export const ASSISTANT_COPY_OWNER = Symbol.for("Rycen7822.metis-pi.copy-assistant");
export const MOUSE_REGION_COPY_OWNER = Symbol.for("Rycen7822.metis-pi.copy-mouse-region");
export const BOX_COPY_OWNER = Symbol.for("Rycen7822.metis-pi.copy-box");
export const CONTAINER_COPY_OWNER = Symbol.for("Rycen7822.metis-pi.copy-container");

function wrapRender<Self extends object>(prototype: object, key: symbol, withCopy?: (self: Self, rows: Rows, width: number) => Rows) {
  if (Object.hasOwn(prototype, key) || !Object.isExtensible(prototype)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  if (!descriptor?.configurable || !descriptor.writable || typeof descriptor.value !== "function") return false;
  const render: Render<Self> = descriptor.value;
  const value: Render<Self> = function (width) {
    let rows = render.call(this, width);
    try {
      if (withCopy) rows = withCopy(this, rows, width);
      publishRows(this, rows);
    } catch { /* Copy metadata must not break rendering. */ }
    return rows;
  };
  Object.defineProperty(prototype, "render", { ...descriptor, value });
  Object.defineProperty(prototype, key, { value: true, configurable: true });
  return true;
}

/** A MouseRegion forwards the child's exact painted rows and their existing product. */
export function wrapMouseRegionPrototype(prototype: object): boolean {
  return wrapRender(prototype, MOUSE_REGION_COPY_OWNER);
}

/** Pi copies an assistant's rows to add zero-width OSC shell integration markers. */
export function wrapAssistantPrototype(prototype: object): boolean {
  type Assistant = { zoneLines?: { source: Rows; lines: Rows } };
  return wrapRender<Assistant>(prototype, ASSISTANT_COPY_OWNER, ({ zoneLines }, rows) => {
    if (zoneLines?.lines === rows) {
      const product = copySourceFor(zoneLines.source);
      if (product) registerProduct(rows, product);
    }
    return rows;
  });
}

/** The native child layout already measured each part; never render children again to align copy. */
function wrapAlignmentPrototype<Self extends ContainerLike>(prototype: object, key: symbol, padding: (self: Self) => [number, number]) {
  const cache = new WeakMap<Self, { native: Rows; published: Rows; sources: readonly (CopySource | undefined)[] }>();
  return wrapRender<Self>(prototype, key, (self, native, width) => {
    const [padX, padY] = padding(self), layout = self.childLines;
    const contentWidth = Math.max(1, width - padX * 2);
    if (layout?.width !== contentWidth || layout.parts.reduce((n, part) => n + part.length, padY * 2) !== native.length) return native;
    const { parts } = layout;
    const sources = parts.map((part, i) => {
      // Prefer fresh provenance only when its visible rows match the native cached part.
      const fresh = publishedRowsOf(layout.children[i]);
      const matches = fresh && (part === fresh || (part.length === fresh.length && part.every((line, j) => line === fresh[j])));
      const source = copySourceFor(matches ? fresh : part);
      return source?.width === contentWidth ? source : undefined;
    });
    const previous = cache.get(self);
    if (previous?.native === native && sources.every((source, i) => source === previous.sources[i])) return previous.published;

    // A visual cache hit may have a new logical source. Never overwrite an already committed frame's provenance.
    const rows = copySourceFor(native) ? native.slice() : native;
    if (sources.some(Boolean)) {
      const children: (ChildPlacement | undefined)[] = new Array(rows.length).fill(undefined);
      let offset = padY;
      for (const [i, part] of parts.entries()) {
        const product = sources[i];
        if (product) for (let rowIndex = 0; rowIndex < part.length; rowIndex++) {
          children[offset + rowIndex] = { product, rowIndex, colShift: padX };
        }
        offset += part.length;
      }
      registerProduct(rows, { width, rows: [], children });
    }
    if (!previous) registerCacheReleaser(self, () => { cache.delete(self); });
    cache.set(self, { native, published: rows, sources });
    return rows;
  });
}

export function wrapBoxPrototype(prototype: object): boolean {
  return wrapAlignmentPrototype<BoxLike>(prototype, BOX_COPY_OWNER, self => [self.paddingX, self.paddingY]);
}

export function wrapContainerPrototype(prototype: object): boolean {
  return wrapAlignmentPrototype(prototype, CONTAINER_COPY_OWNER, () => [0, 0]);
}
