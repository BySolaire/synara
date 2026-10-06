// FILE: SidebarWorkingSection.tsx
// Purpose: Shared, bounded Working list for the classic and Activity sidebar footers.

import type { ReactNode } from "react";

import { SidebarCollapsibleSection } from "./SidebarListSection";
import { ScrollArea } from "./ui/scroll-area";

export function SidebarWorkingSection({
  count,
  open,
  onToggle,
  children,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div data-sidebar-working-section className="px-1.5 py-1.5">
      <SidebarCollapsibleSection label={`Working (${count})`} open={open} onToggle={onToggle}>
        <ScrollArea
          hideScrollbars
          scrollFade
          className="h-auto [&_[data-slot=scroll-area-viewport]]:max-h-[max(0px,calc(40cqh-3rem))]"
        >
          <div className="flex flex-col gap-0.5">{children}</div>
        </ScrollArea>
      </SidebarCollapsibleSection>
    </div>
  );
}
