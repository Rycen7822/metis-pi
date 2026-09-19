import { VoiceHelperClient } from "../helper.js";
import { CodexDictationTranscriber } from "./transcriber.js";
export class CodexDictationSession {
    callbacks;
    helper = new VoiceHelperClient();
    transcriber;
    state = "idle";
    startupFailure;
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.transcriber = new CodexDictationTranscriber({
            onError: (error) => this.fail(error),
            onStatus: (status) => this.callbacks.onStatus(status),
        });
        this.helper.onEvent((event) => this.handleHelperEvent(event));
        this.helper.onExit((error) => this.fail(error));
    }
    async start(auth, config) {
        this.state = "starting";
        this.startupFailure = undefined;
        try {
            await this.helper.start(config.tools.customRustBinariesDir);
            if (this.state !== "starting") {
                if (this.startupFailure)
                    throw this.startupFailure;
                return;
            }
            await this.transcriber.start(auth);
            if (this.state !== "starting") {
                await this.transcriber.close();
                if (this.startupFailure)
                    throw this.startupFailure;
                return;
            }
            this.helper.send({
                type: "start_dictation",
                ...(config.voice.inputDevice ? { microphone: config.voice.inputDevice } : {}),
            });
            this.state = "recording";
        }
        catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.fail(failure);
            await this.helper.close();
            throw failure;
        }
    }
    async finish() {
        if (this.state === "closed" || this.state === "failed" || this.state === "idle")
            return;
        this.state = "finishing";
        try {
            await this.helper.stop();
            if (this.state !== "finishing")
                return;
            const transcript = await this.transcriber.finish();
            if (transcript)
                this.callbacks.onTranscript(transcript);
            await this.close();
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
        }
    }
    async close() {
        if (this.state === "closed")
            return;
        this.state = "closed";
        await Promise.all([this.transcriber.close(), this.helper.close()]);
    }
    handleHelperEvent(event) {
        if (event.type === "error") {
            this.fail(new Error(event.message));
            return;
        }
        if (event.type !== "pcm" || (this.state !== "recording" && this.state !== "finishing"))
            return;
        this.transcriber.append(Buffer.from(event.audio, "base64"));
    }
    fail(error) {
        if (this.state === "idle" || this.state === "closed" || this.state === "failed")
            return;
        this.state = "failed";
        this.startupFailure = error;
        this.callbacks.onError(error);
        void Promise.all([this.transcriber.close(), this.helper.close()]);
    }
}
