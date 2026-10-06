/**
 * Where the composer keeps its roles: per engine, through the one migration in stored-roles.ts.
 * The storage is passed in (the composer hands it `localStorage`), so the read, the stamp-back
 * and the fall back to today's preset are tested without a browser
 * (tests/conformance/engines.test.ts).
 */
import { normalizeRoles, resolveRoles } from "../shared/model-roles.ts";
import { migrateStoredRoles, packStoredRoles, storedRolesKey } from "./stored-roles.ts";
import type { RoleRecord } from "./ui/ModelMenu.tsx";

export type RoleStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The picks remembered for this engine, or null — a record from an older build reads as nothing,
 * so today's preset wins over a saved judge that a different table wrote.
 */
export function readStoredRoles(storage: RoleStorage, engineId: string): RoleRecord | null {
  try {
    return migrateStoredRoles(storage.getItem(storedRolesKey(engineId)));
  } catch {
    return null;
  }
}

export function storeRoles(storage: RoleStorage, engineId: string, roles: RoleRecord | null): void {
  if (!roles) storage.removeItem(storedRolesKey(engineId));
  else storage.setItem(storedRolesKey(engineId), packStoredRoles(roles));
}

/**
 * The roles the composer opens an engine with. The one migration: a record this
 * build cannot vouch for is replaced by the preset for the picked model here and now, so the night
 * after it is judged by the model the table names — not by whichever model an older build
 * happened to save into all three slots.
 */
export function openingRoles(storage: RoleStorage, engineId: string, pickedModel: string | undefined): RoleRecord {
  const stored = readStoredRoles(storage, engineId);
  const next = normalizeRoles(engineId, stored) ?? resolveRoles(engineId, pickedModel);
  if (!stored) storeRoles(storage, engineId, next);
  return next;
}
