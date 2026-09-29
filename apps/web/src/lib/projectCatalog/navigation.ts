import { appHistory } from "../../appNavigation";
import { workspaceRoute } from "../hosts/workspaceFrame";
import { readExecutionContext } from "../hosts/executionContext";
import {
  addWorkspaceSession,
  readWorkspaceSessions,
  waitForWorkspaceNavigation,
} from "../hosts/workspaceSessions";
import { ensureHostsApi } from "../hosts/api";
import { projectCatalogKey } from "./storage";
import type { CatalogCheckout, CheckoutRef } from "./model";

export const CATALOG_OPEN_EVENT = "synara:open-catalog-checkout";
const pendingKey = "synara:pending-catalog-checkout:v1";
export async function openCatalogCheckout(checkout: CatalogCheckout): Promise<void> {
  const context = readExecutionContext();
  const catalogKey = projectCatalogKey();
  if (!context || !catalogKey || checkout.missing) throw new Error("This checkout is unavailable.");
  if (checkout.environmentId === context.execution.environmentId) {
    window.dispatchEvent(new CustomEvent(CATALOG_OPEN_EVENT, { detail: checkout }));
    return;
  }
  if (!checkout.hostId) throw new Error("Select and verify this host in Connections first.");
  const connection = await ensureHostsApi().connect({ hostId: checkout.hostId });
  if (connection.executionScope?.environmentId !== checkout.environmentId)
    throw new Error("This host's identity changed. Pair it again before opening the checkout.");
  if (catalogKey !== projectCatalogKey())
    throw new Error("The account changed. Reopen the catalog.");
  const session = addWorkspaceSession({
    hostId: connection.hostId,
    hostName: connection.hostName,
    wsPath: connection.wsPath,
    executionScope: connection.executionScope,
  });
  const navigation = await waitForWorkspaceNavigation(checkout.environmentId);
  const path = await navigation.openProject(checkout.projectId);
  if (
    catalogKey !== projectCatalogKey() ||
    !readWorkspaceSessions().some(
      (entry) => entry.host === session.host && entry.navigation === navigation,
    )
  )
    throw new Error("The connection changed. Reopen the catalog.");
  appHistory.push(workspaceRoute(checkout.environmentId, path));
}
export function takePendingCatalogCheckout(): CheckoutRef | null {
  const raw = sessionStorage.getItem(pendingKey);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { catalogKey: string; ref: CheckoutRef; createdAt: number };
    if (!Number.isFinite(value.createdAt) || Date.now() - value.createdAt > 60_000) {
      sessionStorage.removeItem(pendingKey);
      return null;
    }
    if (
      value.catalogKey !== projectCatalogKey() ||
      value.ref.environmentId !== readExecutionContext()?.execution.environmentId
    )
      return null;
    sessionStorage.removeItem(pendingKey);
    return value.ref;
  } catch {
    sessionStorage.removeItem(pendingKey);
    return null;
  }
}
