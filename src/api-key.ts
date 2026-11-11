import { readFile } from "node:fs/promises";
import path from "node:path";

export const API_KEY_FLAG_WARNING =
  "Warning: --api-key is deprecated and will be removed. Other users on this machine can read it in the process list. Use SMTPFAST_API_KEY or --api-key-file instead.";

/**
 * The SMTPfast key from --api-key-file, the deprecated --api-key, or
 * SMTPFAST_API_KEY. A key on the command line is in /proc/<pid>/cmdline,
 * which every local user can read, so --api-key still works but warns.
 */
export async function smtpfastKey(
  options: { apiKey?: string; apiKeyFile?: string },
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.error,
): Promise<string> {
  if (options.apiKey !== undefined && options.apiKeyFile !== undefined) throw new Error("Use --api-key-file or --api-key, not both.");
  if (options.apiKeyFile !== undefined) {
    const file = path.resolve(options.apiKeyFile);
    let key: string;
    try {
      key = (await readFile(file, "utf8")).trim();
    } catch (error) {
      throw new Error(`Could not read the API key file ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!key) throw new Error(`The API key file ${file} is empty.`);
    return key;
  }
  if (options.apiKey !== undefined) {
    warn(API_KEY_FLAG_WARNING);
    if (!options.apiKey.trim()) throw new Error("--api-key is empty.");
    return options.apiKey.trim();
  }
  const key = env.SMTPFAST_API_KEY?.trim();
  if (!key) throw new Error("Set SMTPFAST_API_KEY or pass --api-key-file <path>.");
  return key;
}
