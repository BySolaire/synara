import { UpdateDownloadIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { appRailButtonClassName } from "./AppRail";
import { SidebarIconButton } from "./SidebarIconButton";

const LABEL = "Update Canary to the latest commit";

/** Synara Canary only: rebuilds from the tracked ref. Sidebar owns the confirmation and bridge call. */
export function CanaryUpdateRailButton({
  updating,
  onClick,
}: {
  updating: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarIconButton
      icon={UpdateDownloadIcon}
      label={LABEL}
      tooltip={updating ? "Updating Canary…" : LABEL}
      tooltipSide="right"
      size="lg"
      aria-disabled={updating || undefined}
      disabled={updating}
      className={cn(appRailButtonClassName(false), updating && "cursor-not-allowed")}
      onClick={onClick}
    />
  );
}
