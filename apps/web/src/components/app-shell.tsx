"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Bell,
  Building2,
  CreditCard,
  FileText,
  Handshake,
  LayoutDashboard,
  Package,
  Plug,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Truck,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PermissionKey } from "@corridor/domain";
import type { SessionUser } from "@corridor/auth";
import { NavGroup, NavItemContent, ThemeToggle, navItemVariants } from "@corridor/ui";
import { NotificationBell } from "./notifications/notification-bell";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission?: PermissionKey;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/movements", label: "Movements", icon: ArrowLeftRight, permission: "movement.read" },
  { href: "/documents", label: "Documents", icon: FileText, permission: "document.read" },
];

const PARTIES: NavItem[] = [
  { href: "/parties/drivers", label: "Drivers", icon: UserRound, permission: "driver.read" },
  { href: "/parties/trucks", label: "Trucks", icon: Truck, permission: "truck.read" },
  { href: "/parties/trailers", label: "Trailers", icon: Package, permission: "trailer.read" },
  { href: "/parties/partners", label: "Partners", icon: Handshake, permission: "partner.read" },
];

const REST: NavItem[] = [
  { href: "/alerts", label: "Alerts", icon: AlertTriangle, permission: "alert.read" },
  { href: "/reports", label: "Reports", icon: BarChart3, permission: "report.read" },
  { href: "/copilot", label: "Copilot", icon: Sparkles, permission: "copilot.use" },
];

const SETTINGS: NavItem[] = [
  { href: "/settings/organization", label: "Organization", icon: Building2, permission: "organization.read" },
  { href: "/settings/users", label: "Users", icon: Users, permission: "organization.members.read" },
  { href: "/settings/roles", label: "Roles", icon: ShieldCheck, permission: "organization.roles.manage" },
  { href: "/settings/audit", label: "Audit log", icon: ScrollText, permission: "audit_log.read" },
  { href: "/settings/billing", label: "Billing", icon: CreditCard, permission: "billing.read" },
  { href: "/settings/integrations", label: "Integrations", icon: Plug, permission: "integrations.manage" },
  { href: "/settings/notifications", label: "Notifications", icon: Bell },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

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
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const partiesVisible = PARTIES.filter((i) => can(i.permission));
  const settingsVisible = SETTINGS.filter((i) => can(i.permission));
  const partiesActive = partiesVisible.some((i) => isActive(pathname, i.href));
  const settingsActive = settingsVisible.some((i) => isActive(pathname, i.href));

  /** Groups default open when they contain the active route, until manually toggled. */
  const isGroupOpen = (key: string, active: boolean) => openGroups[key] ?? active;
  const setGroupOpen = (key: string) => (open: boolean) =>
    setOpenGroups((prev) => ({ ...prev, [key]: open }));

  const renderItem = (item: NavItem) => (
    <Link key={item.href} href={item.href} className={navItemVariants({ active: isActive(pathname, item.href) })}>
      <NavItemContent icon={item.icon}>{item.label}</NavItemContent>
    </Link>
  );

  return (
    <div className="flex min-h-screen bg-surface-canvas">
      <aside className="flex w-64 shrink-0 flex-col gap-0.5 border-r border-border-default bg-surface-raised p-3">
        <div className="mb-4 px-3 pt-2">
          <div className="text-base font-semibold tracking-tight text-fg-primary">Corridor</div>
          <div className="mt-0.5 truncate text-xs text-fg-secondary">{organizationName}</div>
        </div>

        <nav className="space-y-0.5" aria-label="Primary">
          {NAV.filter((i) => can(i.permission)).map(renderItem)}
          {partiesVisible.length > 0 && (
            <NavGroup
              icon={Users}
              label="Parties"
              active={partiesActive}
              open={isGroupOpen("parties", partiesActive)}
              onOpenChange={setGroupOpen("parties")}
            >
              {partiesVisible.map(renderItem)}
            </NavGroup>
          )}
          {REST.filter((i) => can(i.permission)).map(renderItem)}
        </nav>

        {settingsVisible.length > 0 && (
          <nav className="mt-2" aria-label="Settings">
            <NavGroup
              icon={SettingsIcon}
              label="Settings"
              active={settingsActive}
              open={isGroupOpen("settings", settingsActive)}
              onOpenChange={setGroupOpen("settings")}
            >
              {settingsVisible.map(renderItem)}
            </NavGroup>
          </nav>
        )}

        <div className="mt-auto space-y-2 border-t border-border-default pt-3">
          <div className="flex items-center justify-between px-3">
            <div className="min-w-0">
              <div className="truncate text-sm text-fg-primary">{user.displayName ?? user.email}</div>
              <div className="truncate text-xs text-fg-secondary">{roleName}</div>
            </div>
            <ThemeToggle />
          </div>
          <form action="/auth/signout" method="post" className="px-3">
            <button type="submit" className="text-xs text-fg-secondary hover:text-fg-primary">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="flex justify-end border-b border-border-default bg-surface-raised px-6 py-2">
          <NotificationBell />
        </div>
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
