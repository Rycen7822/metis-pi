import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ChromeLifecycle } from "../chrome/install.ts";
import { METIS_EVENTS } from "../../collaboration.ts";
import type { Renderers } from "../../presentation/contracts.ts";
import { asRecord, type ToolName } from "../../presentation/tool-names.ts";
import type { TranscriptSurface } from "./surface.ts";

type Events = ExtensionAPI["events"];
type SourceInfoFor = (name: string) => unknown;

export interface EmbeddedPresentation {
  attachTui(tui: unknown, root: Component): () => void;
}
export interface EmbeddedTranscript extends EmbeddedPresentation {
  surface: TranscriptSurface;
  renderers: Record<ToolName, Renderers>;
  createEditor?: Awaited<ReturnType<ChromeLifecycle["embeddedEditor"]>>;
  copyKey?: (data: string, editor: unknown) => boolean;
}
export interface EmbeddedSource extends EmbeddedPresentation {
  createTranscript(sourceInfoFor: SourceInfoFor): Promise<EmbeddedTranscript | undefined>;
}

/** One cross-loader handshake; only editable views invoke the lazy transcript factory. */
export async function requestEmbeddedTranscript(events: Events, sourceInfoFor: SourceInfoFor): Promise<EmbeddedTranscript | undefined> {
  return requestEmbeddedPresentation(events)?.createTranscript(sourceInfoFor);
}

export function requestEmbeddedPresentation(events: Events): EmbeddedSource | undefined {
  let result: EmbeddedSource | undefined;
  events.emit(METIS_EVENTS.embeddedTranscript, { accept: (source: EmbeddedSource) => { result ??= source; } });
  return result;
}

export function provideEmbeddedTranscripts(events: Events, source: EmbeddedSource): () => void {
  return events.on(METIS_EVENTS.embeddedTranscript, value => {
    const request = asRecord(value);
    if (typeof request.accept === "function") request.accept(source);
  });
}
