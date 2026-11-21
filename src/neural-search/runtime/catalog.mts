import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export const SEMANTIC_RUNTIME_PATH = "metis/neural-search/semantic/linux-x64";

async function readRecord<T>(file: string, parse: (text: string) => T): Promise<T | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error(`Invalid semantic runtime record: ${file}`);
    return parse(await readFile(file, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export const readJSON = (file: string): Promise<unknown> => readRecord(file, JSON.parse);

export function selectedRuntime(base: string): Promise<string | undefined> {
  return readRecord(join(base, "current"), record => {
    const name = record.trim();
    if (!/^runtime-[A-Za-z0-9]+$/.test(name)) throw new Error("Invalid semantic runtime selection.");
    return join(base, name);
  });
}
