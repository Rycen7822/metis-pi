export function resolveLanVoiceWebTheme(theme) {
    const colors = {
        accent: resolveAnsiColor(theme.getFgAnsi("accent"), "CanvasText"),
        border: resolveAnsiColor(theme.getFgAnsi("border"), "CanvasText"),
        borderMuted: resolveAnsiColor(theme.getFgAnsi("borderMuted"), "GrayText"),
        dim: resolveAnsiColor(theme.getFgAnsi("dim"), "GrayText"),
        error: resolveAnsiColor(theme.getFgAnsi("error"), "CanvasText"),
        muted: resolveAnsiColor(theme.getFgAnsi("muted"), "GrayText"),
        success: resolveAnsiColor(theme.getFgAnsi("success"), "CanvasText"),
        text: resolveAnsiColor(theme.getFgAnsi("text"), "CanvasText"),
        warning: resolveAnsiColor(theme.getFgAnsi("warning"), "CanvasText"),
        customMessageBg: resolveAnsiColor(theme.getBgAnsi("customMessageBg"), "Canvas"),
        selectedBg: resolveAnsiColor(theme.getBgAnsi("selectedBg"), "Canvas"),
        toolErrorBg: resolveAnsiColor(theme.getBgAnsi("toolErrorBg"), "Canvas"),
        toolPendingBg: resolveAnsiColor(theme.getBgAnsi("toolPendingBg"), "Canvas"),
        toolSuccessBg: resolveAnsiColor(theme.getBgAnsi("toolSuccessBg"), "Canvas"),
        userMessageBg: resolveAnsiColor(theme.getBgAnsi("userMessageBg"), "Canvas"),
    };
    const page = colors.userMessageBg;
    return {
        colorScheme: page.rgb ? (relativeLuminance(page.rgb) > 0.5 ? "light" : "dark") : "light dark",
        pageColor: page.css,
        variables: Object.entries(colors)
            .map(([name, color]) => `--pi-${toKebabCase(name)}:${color.css}`)
            .join(";"),
    };
}
function resolveAnsiColor(ansi, resetColor) {
    if (/\x1b\[(?:39|49)m/u.test(ansi))
        return { css: resetColor };
    const trueColor = /\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/u.exec(ansi);
    if (trueColor)
        return rgbColor(Number(trueColor[1]), Number(trueColor[2]), Number(trueColor[3]));
    const indexed = /\x1b\[(?:38|48);5;(\d+)m/u.exec(ansi);
    if (indexed)
        return rgbColor(...ansi256ToRgb(Number(indexed[1])));
    throw new Error("Pi theme returned an unsupported color sequence");
}
function ansi256ToRgb(index) {
    if (!Number.isInteger(index) || index < 0 || index > 255)
        throw new Error("Pi theme returned an invalid indexed color");
    if (index < 16) {
        return [
            [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
            [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
            [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
            [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
        ][index];
    }
    if (index < 232) {
        const value = index - 16;
        const channel = (part) => part === 0 ? 0 : 55 + part * 40;
        return [channel(Math.floor(value / 36)), channel(Math.floor((value % 36) / 6)), channel(value % 6)];
    }
    const gray = 8 + (index - 232) * 10;
    return [gray, gray, gray];
}
function rgbColor(red, green, blue) {
    if (![red, green, blue].every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
        throw new Error("Pi theme returned an invalid RGB color");
    }
    return { css: `rgb(${red} ${green} ${blue})`, rgb: [red, green, blue] };
}
function relativeLuminance([red, green, blue]) {
    const linear = (channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}
function toKebabCase(value) {
    return value.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}
