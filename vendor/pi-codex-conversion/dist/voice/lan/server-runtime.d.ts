import type { Server as HttpsServer } from "node:https";
export declare function collectFailures(promises: ReadonlyArray<Promise<unknown> | undefined>, failures: unknown[]): Promise<void>;
export declare function configureServer(server: HttpsServer): void;
export declare function listen(server: HttpsServer, port: number): Promise<void>;
export declare function lanVoiceUrls(hostnames: string[], ipAddresses: string[], port: number): string[];
