export declare function diagnoseDenoSyntax(deno: string, source: string, env: NodeJS.ProcessEnv, cellSource?: string): Promise<string | undefined>;
export declare function extractDenoSyntaxError(stderr: string, sourceLabel?: string): string | undefined;
