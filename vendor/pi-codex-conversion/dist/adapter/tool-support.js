export function supportsViewImageInputs(model) {
    return Array.isArray(model?.input) && model.input.includes("image");
}
