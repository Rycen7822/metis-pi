export declare function extractNotebookNpmImports(source: string): string[];
export declare function readNotebookNpmImports(identity: {
    project: string;
    agentDir: string;
}): string[];
export declare function recordNotebookNpmImports(identity: {
    project: string;
    agentDir: string;
}, imports: string[]): Promise<string[]>;
export declare function formatNotebookNpmImportsNotice(imports: string[]): string;
