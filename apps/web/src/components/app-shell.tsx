"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PermissionKey } from "@corridor/domain";
import type { SessionUser } from "@corridor/auth";
import { NotificationBell } from "./notifications/notification-bell";

interface NavItem {
  href: string;
  label: string;
  permission?: PermissionKey;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/movements", label: "Movements", permission: "movement.read" },
  { href: "/documents", label: "Documents", permission: "document.read" },
  { href: "/parties/drivers", label: "Drivers", permission: "driver.read" },
  { href: "/parties/trucks", label: "Trucks", permission: "truck.read" },
  { href: "/parties/trailers", label: "Trailers", permission: "trailer.read" },
  { href: "/parties/partners", label: "Partners", permission: "partner.read" },
  { href: "/alerts", label: "Alerts", permission: "alert.read" },
  { href: "/reports", label: "Reports", permission: "report.read" },
  { href: "/copilot", label: "Copilot", permission: "copilot.use" },
];

const SETTINGS: NavItem[] = [
  { href: "/settings/organization", label: "Organization", permission: "organization.read" },
  { href: "/settings/users", label: "Users", permission: "organization.members.read" },
  { href: "/settings/roles", label: "Roles", permission: "organization.roles.manage" },
  { href: "/settings/billing", label: "Billing", permission: "billing.read" },
  { href: "/settings/integrations", label: "Integrations", permission: "integrations.manage" },
  { href: "/settings/notifications", label: "Notifications" },
];

export function AppShell({
  user,
  organizationName,
  roleName,
  permissions,
  children,
}: {
  user: SessionUser;
  organizationName: string;
  roleName: string;
  permissions: PermissionKey[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const can = (p?: PermissionKey) => !p || permissions.includes(p);

  const renderNav = (items: NavItem[]) =>
    items
      .filter((i) => can(i.permission))
      .map((i) => {
        const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link
            key={i.href}
            href={i.href}
            className={`block rounded-md px-3 py-1.5 text-sm ${
              active ? "bg-ink-800 text-white" : "text-ink-300 hover:bg-ink-900 hover:text-white"
            }`}
          >
            {i.label}
          </Link>
        );
      });

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col bg-ink-950 p-4 text-white">
        <div className="mb-6 px-3">
          <div className="text-base font-semibold tracking-tight">Corridor</div>
          <div className="mt-1 truncate text-xs text-ink-500">{organizationName}</div>
        </div>
        <nav className="space-y-0.5">{renderNav(NAV)}</nav>
        <div className="mt-6 px-3 text-[11px] font-medium uppercase tracking-wide text-ink-500">
          Settings
        </div>
        <nav className="mt-1 space-y-0.5">{renderNav(SETTINGS)}</nav>
        <div className="mt-auto border-t border-ink-800 pt-4">
          <div className="truncate px-3 text-sm">{user.displayName ?? user.email}</div>
          <div className="truncate px-3 text-xs text-ink-500">{roleName}</div>
          <form action="/auth/signout" method="post" className="mt-3 px-3">
            <button type="submit" className="text-xs text-ink-300 hover:text-white">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="flex justify-end border-b border-ink-100 bg-white px-6 py-2">
          <NotificationBell />
        </div>
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
