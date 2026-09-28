export interface SourceQuote {
    source: string;
    content: unknown;
}
export interface Obligation {
    id: string;
    timestamp?: number;
    tool: string;
    args: unknown;
    isError: boolean;
    text: string;
    transient?: boolean;
}
export interface ProtectedSources {
    format: "metis-occ-protected-v2";
    requirements: SourceQuote[];
    legacy: SourceQuote[];
    obligations: Obligation[];
    history: string[];
    goal: unknown;
    evidence: string;
    precedence: string;
}
export declare const isDerived: (message: any) => boolean;
/** Only program-owned entry metadata carries authority across compactions. */
export declare function retainSources(entries: Array<{
    sourceEntry: any;
    messages: any[];
}>, effective: any[], requirements: SourceQuote[], obligations: Obligation[], goal: unknown): ProtectedSources;
