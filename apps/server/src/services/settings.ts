import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "@fuluoxiaojie/graph-engine";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";

export interface SrsSettings {
  dailyNewLimit: number;
  requestRetention: number;
  masteryStabilityDays: number;
  enabledModes: {
    recognition: boolean;
    stroke: boolean;
    component: boolean;
    listening: boolean;
  };
  enableTypingInRecognition: boolean;
}

export interface UserSettings {
  sandbox: SandboxConfig;
  srs: SrsSettings;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  sandbox: { ...DEFAULT_SANDBOX_CONFIG },
  srs: {
    dailyNewLimit: 15,
    requestRetention: 0.9,
    masteryStabilityDays: 7,
    enabledModes: {
      recognition: true,
      stroke: true,
      component: true,
      listening: true,
    },
    enableTypingInRecognition: true,
  },
};

export const SandboxConfigSchema = z.object({
  mergeVariants: z.boolean().optional(),
  frequencyPreset: z.enum(["subtlex", "junda", "hsk", "blend"]).optional(),
  blendSubtlexWeight: z.number().min(0).max(1).optional(),
  weightTransform: z.enum(["log", "power", "rank", "raw"]).optional(),
  logScale: z.number().min(1).max(1_000_000).optional(),
  powerGamma: z.number().min(0.05).max(1).optional(),
  rankOffset: z.number().min(1).max(10_000).optional(),
  algorithm: z.enum(["reverse-topo", "pagerank", "coverage", "raw"]).optional(),
  damping: z.number().min(0).max(1).optional(),
  useMultiplicity: z.boolean().optional(),
  roleWeights: z
    .object({
      semantic: z.number().min(0).max(10).optional(),
      phonetic: z.number().min(0).max(10).optional(),
      structural: z.number().min(0).max(10).optional(),
    })
    .optional(),
  onlyRemainingMass: z.boolean().optional(),
  holisticBypassTopN: z.number().int().min(0).max(1000).optional(),
  plannerStrategy: z.enum(["priority-topo", "greedy-unlock"]).optional(),
  greedyClusterExponent: z.number().min(0.5).max(3).optional(),
});

export const UserSettingsPatchSchema = z.object({
  sandbox: SandboxConfigSchema.optional(),
  srs: z
    .object({
      dailyNewLimit: z.number().int().min(1).max(200).optional(),
      requestRetention: z.number().min(0.7).max(0.97).optional(),
      masteryStabilityDays: z.number().min(0.5).max(365).optional(),
      enabledModes: z
        .object({
          recognition: z.boolean().optional(),
          stroke: z.boolean().optional(),
          component: z.boolean().optional(),
          listening: z.boolean().optional(),
        })
        .optional(),
      enableTypingInRecognition: z.boolean().optional(),
    })
    .optional(),
});

export type UserSettingsPatch = z.infer<typeof UserSettingsPatchSchema>;

export function mergeUserSettings(base: UserSettings, patch: UserSettingsPatch): UserSettings {
  return {
    sandbox: {
      ...base.sandbox,
      ...(patch.sandbox ?? {}),
      roleWeights: {
        ...base.sandbox.roleWeights,
        ...(patch.sandbox?.roleWeights ?? {}),
      },
    },
    srs: {
      ...base.srs,
      ...(patch.srs ?? {}),
      enabledModes: {
        ...base.srs.enabledModes,
        ...(patch.srs?.enabledModes ?? {}),
      },
    },
  };
}

export function getUserSettings(db: AppDatabase): UserSettings {
  const row = db.prepare("SELECT config_json FROM user_settings WHERE id = 1").get() as
    | { config_json: string }
    | undefined;
  if (!row) return structuredClone(DEFAULT_USER_SETTINGS);
  try {
    const parsed = UserSettingsPatchSchema.safeParse(JSON.parse(row.config_json));
    if (!parsed.success) return structuredClone(DEFAULT_USER_SETTINGS);
    return mergeUserSettings(DEFAULT_USER_SETTINGS, parsed.data);
  } catch {
    return structuredClone(DEFAULT_USER_SETTINGS);
  }
}

export function saveUserSettings(db: AppDatabase, patch: UserSettingsPatch): UserSettings {
  const current = getUserSettings(db);
  const next = mergeUserSettings(current, patch);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_settings (id, config_json, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`
  ).run(JSON.stringify(next), now);
  return next;
}
