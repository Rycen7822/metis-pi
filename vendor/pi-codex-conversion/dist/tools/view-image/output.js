export function imageContentsFromViewImageDetails(details) {
    if (!details || typeof details !== "object")
        return [];
    const description = details.viewImageDescription;
    if (!description || typeof description !== "object")
        return [];
    const image = description.image;
    return isViewImageContent(image) ? [image] : [];
}
export function imageContentFromViewImageOutput(output) {
    return imageContentsFromViewImageOutput(output)[0];
}
export function imageContentsFromViewImageOutput(output) {
    const trimmed = output.trim();
    if (!trimmed)
        return [];
    const whole = imageContentFromJson(trimmed);
    if (whole)
        return [whole];
    return trimmed.split(/\r?\n/).flatMap((line) => {
        const image = imageContentFromJson(line.trim());
        return image ? [image] : [];
    });
}
function imageContentFromJson(json) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object")
        return undefined;
    const imageUrl = parsed["image_url"];
    const detail = parsed["detail"];
    if (typeof imageUrl !== "string" || (detail !== "high" && detail !== "original"))
        return undefined;
    const match = imageUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
    return match ? { type: "image", mimeType: match[1], data: match[2], detail } : undefined;
}
function isViewImageContent(value) {
    return Boolean(value && typeof value === "object"
        && value.type === "image"
        && typeof value.data === "string"
        && typeof value.mimeType === "string"
        && (value.detail === "high" || value.detail === "original"));
}
