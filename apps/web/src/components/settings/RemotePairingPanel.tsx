import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Schema } from "effect";
import {
  RemotePairingBundle,
  type RemoteAccessRequest,
  type RemoteAccessResult,
} from "@synara/contracts";
import { readHostsApi } from "~/lib/hosts/api";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingsSection, SettingsListRow } from "./SettingsPanelPrimitives";

type HostState = Extract<RemoteAccessResult, { kind: "host-state" }>;
const call = (request: RemoteAccessRequest) => {
  const access = readHostsApi()?.remoteAccess;
  if (!access)
    return Promise.reject(new Error("Update the local controller to manage device pairing."));
  return access(request);
};

/** The owner approves the exact device proof on the computer being shared. */
export function RemotePairingPanel() {
  if (readExecutionContext()?.controller.capabilities.remoteConnections !== true) return null;
  return <EnabledRemotePairingPanel />;
}

function EnabledRemotePairingPanel() {
  const inputId = useId();
  const [state, setState] = useState<HostState | null>(null);
  const [invitation, setInvitation] = useState<RemotePairingBundle | null>(null);
  const [bundleText, setBundleText] = useState("");
  const imported = useMemo(() => {
    if (!bundleText || bundleText.length > 20_000) return null;
    try {
      return Schema.decodeUnknownSync(RemotePairingBundle)(JSON.parse(bundleText));
    } catch {
      return null;
    }
  }, [bundleText]);
  const [deviceJkt, setDeviceJkt] = useState("");
  const [busy, setBusy] = useState(false);
  const [pairingHost, setPairingHost] = useState<RemotePairingBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const next = await call({ operation: "list" });
      if (mounted.current && sequence === refreshSequence.current && next.kind === "host-state")
        setState(next);
    } catch (cause) {
      if (mounted.current && sequence === refreshSequence.current)
        setError(cause instanceof Error ? cause.message : "Remote access unavailable.");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    void call({ operation: "device-info" }).then(
      (info) => {
        if (mounted.current && info.kind === "device-info") setDeviceJkt(info.deviceJkt);
      },
      () => {},
    );
    const timer = setInterval(() => {
      void refresh();
    }, 3_000);
    return () => {
      mounted.current = false;
      refreshSequence.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  const perform = async (request: RemoteAccessRequest) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    refreshSequence.current++;
    try {
      const result = await call(request);
      if (!mounted.current) return;
      if (result.kind === "invitation") setInvitation(result.bundle);
      if (result.kind === "paired") {
        setBundleText("");
        setNotice("Device approved. You can now connect to this host.");
      }
      await refresh();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The request did not complete. Check the host before retrying.",
        );
    } finally {
      if (mounted.current) {
        setBusy(false);
        setPairingHost(null);
      }
    }
  };
  const pair = () => {
    try {
      const bundle = imported;
      if (!bundle) throw new Error("Invalid invitation");
      setPairingHost(bundle);
      void perform({ operation: "pair", bundle });
    } catch {
      setError("Paste a complete, unexpired invitation from your other computer.");
    }
  };
  const forget = async () => {
    if (
      !imported ||
      !(await ensureNativeApi().dialogs.confirm(
        `Forget the saved identity for ${imported.label}?\nIts active connections will close. Verify a new invitation on the host before pairing again.`,
      ))
    )
      return;
    await perform({ operation: "forget-host", environmentId: imported.environmentId });
  };
  const reset = async () => {
    const local = readExecutionContext()?.controller;
    if (
      !local ||
      !(await ensureNativeApi().dialogs.confirm(
        "Reset remote access on this computer?\nAll device approvals and invitations will be revoked. Pair each device again. Your projects and chats stay here.",
      ))
    )
      return;
    await perform({ operation: "reset-identity", environmentId: local.environmentId });
  };
  return (
    <>
      <SettingsSection title="Approve devices for this computer">
        <SettingsListRow
          title="Local approval required"
          description="An account alone does not grant access. Create an invitation here, then confirm the requesting device below."
          actions={
            <Button
              size="xs"
              disabled={busy}
              onClick={() => void perform({ operation: "create-invitation" })}
            >
              Create invitation
            </Button>
          }
        />
        {invitation ? (
          <div className="space-y-2 p-3">
            <p className="text-ui-sm text-muted-foreground">
              Transfer this invitation privately to your other device. It expires at{" "}
              {new Date(invitation.expiresAt).toLocaleTimeString()}.
            </p>
            <Textarea
              aria-label="Remote access invitation"
              readOnly
              value={JSON.stringify(invitation)}
              className="[&_textarea]:min-h-24 [&_textarea]:break-all [&_textarea]:text-ui-xs"
            />
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void perform({ operation: "cancel-invitation", inviteId: invitation.inviteId });
                setInvitation(null);
              }}
            >
              Cancel invitation
            </Button>
          </div>
        ) : null}
        {state?.invitations
          .filter(
            (entry) =>
              !entry.revoked &&
              !entry.approved &&
              Date.parse(entry.expiresAt) > Date.now() &&
              entry.pendingDevice,
          )
          .map((entry) => (
            <SettingsListRow
              key={entry.inviteId}
              align="start"
              title={entry.pendingDevice!.label}
              description={
                <span className="flex flex-col gap-1">
                  <span>Compare this fingerprint with the requesting device.</span>
                  <code className="break-all text-ui-xs text-foreground">
                    {entry.pendingDevice!.deviceJkt}
                  </code>
                </span>
              }
              actions={
                <>
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() =>
                      void perform({
                        operation: "approve",
                        inviteId: entry.inviteId,
                        deviceJkt: entry.pendingDevice!.deviceJkt,
                      })
                    }
                  >
                    Approve this device
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void perform({ operation: "cancel-invitation", inviteId: entry.inviteId })
                    }
                  >
                    Reject
                  </Button>
                </>
              }
            />
          ))}
        {state?.devices
          .filter((device) => !device.revokedAt)
          .map((device) => (
            <SettingsListRow
              key={device.deviceJkt}
              title={device.label}
              description={<code className="break-all text-ui-xs">{device.deviceJkt}</code>}
              actions={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() =>
                    void perform({ operation: "revoke-device", deviceJkt: device.deviceJkt })
                  }
                >
                  Revoke on this host
                </Button>
              }
            />
          ))}
        {state?.rootNeedsRepair ? (
          <SettingsListRow
            title="Remote identity needs attention"
            description="If you previously paired devices, reset access and pair them again."
            actions={
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void reset()}
              >
                Reset access
              </Button>
            }
          />
        ) : null}
      </SettingsSection>
      <SettingsSection title="Pair another computer">
        <div className="space-y-3 p-3">
          <label htmlFor={inputId} className="block text-ui-sm font-medium">
            Invitation from the host
          </label>
          <Textarea
            id={inputId}
            value={bundleText}
            disabled={busy}
            onChange={(event) => setBundleText(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="[&_textarea]:min-h-24 [&_textarea]:text-ui-xs"
          />
          {imported ? (
            <p className="text-ui-sm text-muted-foreground">
              Host: {imported.label} · {imported.channel}
            </p>
          ) : null}
          {deviceJkt ? (
            <div className="space-y-1">
              <p className="text-ui-sm text-muted-foreground">This device’s fingerprint</p>
              <code className="block break-all text-ui-xs">{deviceJkt}</code>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy || !bundleText.trim() || !deviceJkt} onClick={pair}>
              {pairingHost ? "Waiting for host approval…" : "Request access"}
            </Button>
            {pairingHost ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void call({
                    operation: "forget-host",
                    environmentId: pairingHost.environmentId,
                  }).catch(() =>
                    setError(
                      "Could not cancel pairing. Close this view and review the invitation on the host.",
                    ),
                  );
                }}
              >
                Cancel request
              </Button>
            ) : null}
          </div>
          {imported && !busy ? (
            <Button size="xs" variant="ghost" onClick={() => void forget()}>
              Forget previous pairing for this host
            </Button>
          ) : null}
          {pairingHost ? (
            <p className="text-ui-sm text-muted-foreground">
              On {pairingHost.label}, open Connections and approve the fingerprint shown above.
            </p>
          ) : null}
        </div>
      </SettingsSection>
      {error ? (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-ui text-foreground">
          {notice}
        </p>
      ) : null}
    </>
  );
}
