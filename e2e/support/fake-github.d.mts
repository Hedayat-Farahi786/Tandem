export declare const PEOPLE: Record<string, { id: number; login: string; name: string }>;
export declare function startFakeGitHub(): Promise<{ url: string; close: () => Promise<void> }>;
export declare function webAppEnv(o: { github: string; url: string; secretKey: string }): Record<string, string>;
