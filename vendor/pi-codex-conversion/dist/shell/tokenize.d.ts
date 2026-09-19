export declare function shellSplit(input: string): string[];
export declare function shellQuote(token: string): string;
export declare function joinCommandTokens(tokens: string[]): string;
export declare function normalizeTokens(tokens: string[]): string[];
export declare function splitOnConnectors(tokens: string[]): string[][];
export declare function shortDisplayPath(path: string): string;
export declare function joinPaths(base: string, extra: string): string;
export declare function isAbsoluteLike(path: string): boolean;
