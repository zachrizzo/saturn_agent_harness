import type { AppSettings } from "@/lib/settings";

type EmbeddingsModule = Record<string, unknown>;

export type EmbeddingsAvailability =
  | { available: true; module: EmbeddingsModule }
  | { available: false; reason: string };

export function memoryRetrievalSettings(settings: AppSettings) {
  return {
    mode: settings.memoryRetrievalMode,
    embedding: {
      provider: settings.memoryEmbeddingProvider,
      model: settings.memoryEmbeddingModel,
      baseUrl: settings.memoryEmbeddingBaseUrl,
      apiKeyConfigured: Boolean(settings.memoryEmbeddingApiKey),
      dimensions: settings.memoryEmbeddingDimensions,
    },
    curator: {
      enabled: settings.memoryCuratorEnabled,
      provider: settings.memoryCuratorProvider,
      model: settings.memoryCuratorModel,
      baseUrl: settings.memoryCuratorBaseUrl,
      apiKeyConfigured: Boolean(settings.memoryCuratorApiKey),
    },
  };
}

export async function loadEmbeddingsModule(): Promise<EmbeddingsAvailability> {
  try {
    const mod = await import("@/lib/memory/" + "embeddings") as EmbeddingsModule;
    return { available: true, module: mod };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("Cannot find module")
      || message.includes("Module not found")
      || message.includes("Can't resolve")
    ) {
      return { available: false, reason: "dashboard/lib/memory/embeddings module is not installed" };
    }
    throw err;
  }
}

export function findExport(mod: EmbeddingsModule, names: string[]): ((...args: unknown[]) => Promise<unknown> | unknown) | undefined {
  for (const name of names) {
    const value = mod[name];
    if (typeof value === "function") return value as (...args: unknown[]) => Promise<unknown> | unknown;
  }
  return undefined;
}

export async function callOptionalEmbeddingsStatus(settings: AppSettings): Promise<unknown | undefined> {
  try {
    const loaded = await loadEmbeddingsModule();
    if (!loaded.available) return undefined;
    const fn = findExport(loaded.module, [
      "getMemoryEmbeddingsStatus",
      "getEmbeddingsStatus",
      "getEmbeddingStatus",
      "memoryEmbeddingsStatus",
    ]);
    if (!fn) return undefined;
    return await fn({ settings });
  } catch {
    return undefined;
  }
}
