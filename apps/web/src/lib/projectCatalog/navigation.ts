import { activateHost, deactivateHost } from "../hosts/activeHost";
import { readExecutionContext } from "../hosts/executionContext";
import { flushBeforeExecutionSwitch } from "../hosts/executionSwitch";
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
  await flushBeforeExecutionSwitch();
  if (checkout.environmentId === context.controller.environmentId) {
    sessionStorage.setItem(
      pendingKey,
      JSON.stringify({ catalogKey, ref: checkout, createdAt: Date.now() }),
    );
    try {
      deactivateHost();
    } catch (error) {
      sessionStorage.removeItem(pendingKey);
      throw error;
    }
    return;
  }
  if (!checkout.hostId) throw new Error("Select and verify this host in Connections first.");
  const connection = await ensureHostsApi().connect({ hostId: checkout.hostId });
  if (connection.executionScope?.environmentId !== checkout.environmentId)
    throw new Error("This host's identity changed. Pair it again before opening the checkout.");
  if (catalogKey !== projectCatalogKey())
    throw new Error("The account changed. Reopen the catalog.");
  sessionStorage.setItem(
    pendingKey,
    JSON.stringify({ catalogKey, ref: checkout, createdAt: Date.now() }),
  );
  try {
    await activateHost({
      hostId: connection.hostId,
      hostName: connection.hostName,
      wsPath: connection.wsPath,
      executionScope: connection.executionScope,
    });
  } catch (error) {
    sessionStorage.removeItem(pendingKey);
    throw error;
  }
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
