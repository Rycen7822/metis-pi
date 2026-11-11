import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ChromeLifecycle } from "../chrome/install.ts";
import { METIS_EVENTS } from "../../collaboration.ts";
import type { Renderers } from "../../presentation/contracts.ts";
import type { ToolName } from "../../presentation/tool-names.ts";
import { asRecord } from "../../presentation/tool-names.ts";
import type { TranscriptSurface } from "./surface.ts";

type Events = ExtensionAPI["events"];

export interface EmbeddedTranscript {
  surface: TranscriptSurface;
  renderers: Record<ToolName, Renderers>;
  attachTui(tui: unknown, root: Component): () => void;
  createEditor?: Awaited<ReturnType<ChromeLifecycle["embeddedEditor"]>>;
  copyKey?: (data: string, editor: unknown) => boolean;
}

interface SurfaceRequest {
  sourceInfoFor: (name: string) => unknown;
  accept: (view: Promise<EmbeddedTranscript | undefined>) => void;
}

/** The event bus crosses extension loader instances without a global UI owner. */
export async function requestEmbeddedTranscript(
  events: Events, sourceInfoFor: SurfaceRequest["sourceInfoFor"],
): Promise<EmbeddedTranscript | undefined> {
  let result: Promise<EmbeddedTranscript | undefined> | undefined;
  const request: SurfaceRequest = { sourceInfoFor, accept: view => { result ??= view; } };
  events.emit(METIS_EVENTS.btwTranscript, request);
  return result;
}

export function provideEmbeddedTranscripts(
  events: Events,
  create: (sourceInfoFor: SurfaceRequest["sourceInfoFor"]) => Promise<EmbeddedTranscript | undefined>,
): () => void {
  return events.on(METIS_EVENTS.btwTranscript, value => {
    const record = asRecord(value);
    if (typeof record.sourceInfoFor !== "function" || typeof record.accept !== "function") return;
    // This callback protocol is private to the two Metis extension entries.
    const request = value as SurfaceRequest;
    const view = create(request.sourceInfoFor);
    if (view) request.accept(view);
  });
}
