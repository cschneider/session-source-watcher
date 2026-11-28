// SPDX-License-Identifier: Apache-2.0
import type { SourceAdapter } from "../core/source.js";

export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  get(type: string): SourceAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) throw new Error(`Unknown source type ${type}`);
    return adapter;
  }

  /** Find the adapter for a URL, or the named type. */
  resolve(input: string, type?: string): { adapter: SourceAdapter; key: string; locator: unknown; url: string } {
    const candidates = type ? [this.get(type)] : [...this.adapters.values()];
    const errors: string[] = [];
    for (const adapter of candidates) {
      try {
        return { adapter, ...adapter.canonicalize(input) };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(errors[0] ?? `Unsupported source: ${input}`);
  }
}
