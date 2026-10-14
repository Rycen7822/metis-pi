// Lightweight optional-SDK substitute for the localized preview layout test.
const strings = new Map<string, Record<string, Record<string, string>>>();
let locale = "en";
export const applyLocale = (value: string) => { locale = value; };
export const registerStrings = (namespace: string, values: Record<string, Record<string, string>>) => { strings.set(namespace, values); };
export const scope = (namespace: string) => (key: string, fallback: string) => strings.get(namespace)?.[locale]?.[key] ?? fallback;
