import { readFileSync } from "node:fs";
import { resolveLanVoiceWebTheme } from "./theme.js";
const ASSETS = {
    "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
    "/favicon.svg": ["gippity-icon.svg", "image/svg+xml"],
    "/icon-192.png": ["gippity-icon-192.png", "image/png"],
    "/icon-512.png": ["gippity-icon-512.png", "image/png"],
};
const cache = new Map();
export function getLanVoiceAppAsset(path) {
    if (!(path in ASSETS))
        return undefined;
    const assetPath = path;
    const [filename, contentType] = ASSETS[assetPath];
    let body = cache.get(assetPath);
    if (!body) {
        body = readFileSync(new URL(`../../../src/voice/lan/assets/${filename}`, import.meta.url));
        cache.set(assetPath, body);
    }
    return { body, contentType };
}
export function createLanVoiceWebManifest(piTheme) {
    const theme = resolveLanVoiceWebTheme(piTheme);
    return JSON.stringify({
        id: "/",
        name: "GipPity remote control",
        short_name: "GipPity",
        description: "Voice and message remote control for the active Pi session",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: theme.pageColor,
        theme_color: theme.pageColor,
        icons: [
            { src: "/icon-192.png?v=2", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/icon-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
    });
}
