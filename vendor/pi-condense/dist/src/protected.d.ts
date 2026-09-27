/** Structural pick of ContextPruneConfig — keeps this module dependency-free. */
export interface ProtectionConfig {
    protectedTools: readonly string[];
    protectedPaths: readonly string[];
}
export declare function globToRegExp(pattern: string): RegExp;
/** Identity normalization shared by protection matching and supersession: slash direction only, no resolution. */
export declare function normalizePath(path: string): string;
export declare function isProtected(toolName: string, args: unknown, config: ProtectionConfig): boolean;
