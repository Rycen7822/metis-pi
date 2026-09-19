import { VoiceHelperClient } from "../helper.js";
import { startRealtimeOffer } from "../conversation/helper-offer.js";
export class LanHostRealtimePeer {
    kind = "webrtc";
    helper = new VoiceHelperClient();
    onAudio;
    constructor(options) {
        this.onAudio = options.onAudio;
    }
    onEvent(listener) {
        return this.helper.onEvent((event) => {
            if (event.type === "pcm") {
                this.onAudio(Buffer.from(event.audio, "base64"));
                return;
            }
            const peerEvent = toPeerEvent(event);
            if (peerEvent)
                listener(peerEvent);
        });
    }
    onExit(listener) {
        return this.helper.onExit(listener);
    }
    start(config) {
        return startRealtimeOffer(this.helper, config, "bridge");
    }
    applyAnswer(sdp) {
        this.helper.send({ type: "apply_answer", sdp });
    }
    sendData(message) {
        this.helper.send({ type: "send_data", message });
    }
    sendAudio(pcm) {
        this.helper.send({ type: "send_pcm", audio: pcm.toString("base64"), sample_rate: 24_000, num_channels: 1 });
    }
    setInputMuted(muted) {
        this.helper.send({ type: "set_input_muted", muted });
    }
    close() {
        return this.helper.close();
    }
}
function toPeerEvent(event) {
    if (event.type === "state" || event.type === "data" || event.type === "error")
        return event;
    return undefined;
}
