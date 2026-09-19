export interface LanVoiceCertificate {
    cert: string;
    key: string;
    hostnames: string[];
    ipAddresses: string[];
}
export declare function resolveLanVoiceCertificate(agentDir: string): Promise<LanVoiceCertificate>;
