import type { AppConfig } from "./config.js";
import { ContainerDependencyRunner } from "./container-dependency-runner.js";
import { DependencyManager } from "./dependency-manager.js";

export function createDependencyManager(config: AppConfig): DependencyManager {
  return new DependencyManager(config, new ContainerDependencyRunner(config));
}
