export declare function editorCommand(): string | undefined;
export declare function splitEditorCommand(command: string, platform?: NodeJS.Platform): string[];
export declare function openCodexConfigInExternalEditor(file: string, folderScope: boolean, stopTui: () => void, startTui: () => void, requestRender: (full?: boolean) => void): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
