import type { AudioEnhancer } from "./types.js";
import { BasicEnhancer } from "./basic.js";
import { DeepFilterNetEnhancer } from "./deepfilternet.js";
import { UniseEnhancer } from "./unise.js";

const enhancers = new Map<string, AudioEnhancer>();

/** Register an enhancer by name */
export function registerEnhancer(enhancer: AudioEnhancer): void {
  enhancers.set(enhancer.name, enhancer);
}

/** Get an enhancer by name */
export function getEnhancer(name: string): AudioEnhancer | undefined {
  return enhancers.get(name);
}

/** List all registered enhancer names */
export function listEnhancers(): string[] {
  return Array.from(enhancers.keys());
}

/** Initialize all built-in enhancers */
export function registerBuiltinEnhancers(): void {
  registerEnhancer(new BasicEnhancer());
  registerEnhancer(new DeepFilterNetEnhancer());
  registerEnhancer(new UniseEnhancer());
}
