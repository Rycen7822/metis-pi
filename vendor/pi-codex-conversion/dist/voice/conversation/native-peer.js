import { VoiceHelperClient } from "../helper.js";
import { startRealtimeOffer } from "./helper-offer.js";
export class NativeCodexRealtimePeer {
    kind = "webrtc";
    helper = new VoiceHelperClient();
    onEvent(listener) {
        return this.helper.onEvent((event) => {
            const peerEvent = toPeerEvent(event);
            if (peerEvent)
                listener(peerEvent);
        });
    }
    onExit(listener) {
        return this.helper.onExit(listener);
    }
    start(config) {
        return startRealtimeOffer(this.helper, config, "native");
    }
    applyAnswer(sdp) {
        this.helper.send({ type: "apply_answer", sdp });
    }
    sendData(message) {
        this.helper.send({ type: "send_data", message });
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
