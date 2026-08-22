// PM provider registry — the single place a project-management integration is registered. Add a provider by
// importing its module and adding ONE entry here; the generic IPC (main), preload bridges, settings form, and
// sidebar rail all read the registry, so nothing else changes. Mirrors the git-provider PROVIDERS registry.

import type { PmProvider, PmProviderMeta } from './types';
import { pmMeta } from './types';
import { echo } from './echo';

export type { PmProvider, PmProviderMeta } from './types';

// ← Register new providers here (e.g. jira, linear, asana). One line each.
export const PM_PROVIDERS: Record<string, PmProvider> = { echo };

export const pmProviderOf = (id: string): PmProvider | undefined => PM_PROVIDERS[id];

// Safe metadata for the renderer (no functions, no secrets) — the UI builds itself from this.
export const pmProviderList = (): PmProviderMeta[] => Object.values(PM_PROVIDERS).map(pmMeta);
