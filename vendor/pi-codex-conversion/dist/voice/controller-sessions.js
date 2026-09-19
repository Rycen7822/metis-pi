export async function startControllerConversation(options) {
    if (options.signal?.aborted) {
        await options.peer?.close();
        return;
    }
    const { CodexRealtimeConversation } = await import("./conversation/session.js");
    if (!options.lifecycle.stillAuthorizing() || options.signal?.aborted) {
        await options.peer?.close();
        return;
    }
    const realtimePeer = options.peer ?? new (await import("./conversation/native-peer.js")).NativeCodexRealtimePeer();
    if (!options.lifecycle.stillAuthorizing() || options.signal?.aborted) {
        await realtimePeer.close();
        return;
    }
    let session;
    session = new CodexRealtimeConversation({
        onError: (error) => options.lifecycle.onError(session, error),
        onDrop: (error) => options.lifecycle.onDrop(session, error),
        onStatus: options.lifecycle.onStatus,
        onTurn: (turn) => options.lifecycle.onTurn(session, turn),
        onUserTranscript: options.lifecycle.onUserTranscript,
        onTranscriptTail: options.lifecycle.onTranscriptTail,
        onEvent: options.lifecycle.onEvent,
    }, realtimePeer);
    options.lifecycle.onCreated(session);
    if (options.signal?.aborted) {
        await session.close();
        return;
    }
    const closeOnAbort = () => { void session.close(); };
    options.signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
        await session.start(options.auth, options.config, options.instructions, options.initialItems, options.inputMuted);
    }
    finally {
        options.signal?.removeEventListener("abort", closeOnAbort);
    }
    if (options.lifecycle.isCurrent(session)) {
        session.markEstablished();
        options.lifecycle.onActive(session);
        if (options.greeting) {
            setTimeout(() => {
                if (options.lifecycle.isCurrent(session))
                    session.greet(options.greeting === "contextual");
            }, 0).unref?.();
        }
    }
    else
        await session.close();
}
export async function startControllerDictation(options) {
    const { CodexDictationSession } = await import("./dictation/session.js");
    if (!options.lifecycle.stillAuthorizing())
        return;
    let session;
    session = new CodexDictationSession({
        onError: (error) => options.lifecycle.onError(session, error),
        onStatus: options.lifecycle.onStatus,
        onTranscript: options.lifecycle.onTranscript,
    });
    options.lifecycle.onCreated(session);
    await session.start(options.auth, options.config);
    if (options.lifecycle.isCurrent(session))
        options.lifecycle.onActive(session);
    else
        await session.close();
}
