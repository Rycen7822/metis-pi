/**
 * Per-request image cap (`maxImagesPerRequest`).
 *
 * Providers reject a request carrying more images than their limit, and every
 * image a model has seen stays in the transcript, so a long session can cross
 * the limit and then fail on every request. Once a request carries more than
 * `max` images, `capImages` replaces the oldest ones with a text note, in steps
 * of half the cap so the prompt prefix changes rarely. It never mutates its
 * input; it returns `undefined` when nothing changes.
 */
export declare const IMAGE_OMITTED_NOTE = "[earlier image omitted from this request: over maxImagesPerRequest; re-read the file or re-attach it to view it]";
/** The effective cap: an explicit `maxImagesPerRequest` wins, else the built-in limit for the model's API. */
export declare function imageLimitFor(configured: number | null, api: string | undefined): number | null;
export declare function capImages<M extends object>(messages: M[], max: number): M[] | undefined;
