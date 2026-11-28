// SPDX-License-Identifier: Apache-2.0
import { SourceRegistry } from "../daemon/registry.js";
import { GitHubPullRequestSource } from "../sources/github/pullRequest.js";

export function defaultSources(): SourceRegistry {
  const registry = new SourceRegistry();
  registry.register(new GitHubPullRequestSource());
  return registry;
}
