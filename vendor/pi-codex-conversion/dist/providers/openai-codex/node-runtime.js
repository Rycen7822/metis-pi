var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
const dynamicImport = (specifier) => import(__rewriteRelativeImportExtension(specifier));
export const osInfo = { current: null };
if (typeof process !== "undefined" && (process.versions?.node || process.versions["bun"])) {
    dynamicImport("node:os")
        .then((module) => {
        osInfo.current = module;
    })
        .catch(() => {
        osInfo.current = null;
    });
}
