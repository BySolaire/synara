import { readVerifiedControllerForRecovery } from "./lib/hosts/controllerRecovery";
// FILE: bootstrap.ts
// Purpose: Completes synchronous renderer storage migration before any app store can hydrate.

import "./storageOriginMigration";

import { migrateLocalComposerImageBlobs } from "./lib/composerImageBlobStore";
import { bootstrapExecutionContext } from "./lib/hosts/connectionClients";
import { deactivateHost } from "./lib/hosts/activeHost";
import { bootstrapSignedOutScreen } from "./authSignedOut";
import { bootstrapPairingSession } from "./pairingBootstrap";

if (!bootstrapSignedOutScreen()) {
  void bootstrapPairingSession().then((result) => {
    if (result === "not-pairing") {
      return bootstrapExecutionContext()
        .then(() => migrateLocalComposerImageBlobs())
        .then(() => import("./main"))
        .catch((error: unknown) => {
          const main = document.createElement("main");
          main.style.cssText = "font:16px system-ui;max-width:32rem;margin:12vh auto;padding:2rem";
          const cached = readVerifiedControllerForRecovery();
          const title = document.createElement("h1");
          title.textContent = cached
            ? `${cached.label} · connection unavailable`
            : "Connection unavailable";
          const detail = document.createElement("p");
          detail.textContent =
            error instanceof Error ? error.message : "The execution host could not be verified.";
          const local = document.createElement("button");
          local.textContent = "Return to this computer";
          local.onclick = deactivateHost;
          const retry = document.createElement("button");
          retry.textContent = "Retry";
          retry.onclick = () => window.location.reload();
          main.append(title, detail, local, retry);
          document.body.replaceChildren(main);
        });
    }
  });
}
