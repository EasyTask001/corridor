"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  CircleUser,
  CreditCard,
  FileCheck2,
  FileText,
  Handshake,
  HelpCircle,
  LayoutDashboard,
  Menu,
  Package,
  Plug,
  Route,
  Scale,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  Ship,
  Sparkles,
  Truck,
  UserRound,
  Users,
  Warehouse,
  X,
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

interface NavSection {
  key: string;
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

const DASHBOARD: NavItem = { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard };
const COPILOT: NavItem = {
  href: "/copilot",
  label: "Copilot",
  icon: Sparkles,
  permission: "copilot.use",
};

const NAV_SECTIONS: NavSection[] = [
  {
    key: "operations",
    label: "Operations",
    icon: ArrowLeftRight,
    items: [
      { href: "/movements", label: "Movements", icon: ArrowLeftRight, permission: "movement.read" },
      { href: "/shipments", label: "Shipments", icon: Ship, permission: "shipment.read" },
      { href: "/in-bond", label: "In-bond", icon: Warehouse, permission: "inbond.read" },
      { href: "/pars-rns", label: "PARS RNS", icon: FileCheck2, permission: "shipment.read" },
      { href: "/documents", label: "Documents", icon: FileText, permission: "document.read" },
    ],
  },
  {
    key: "directory",
    label: "Directory",
    icon: Users,
    items: [
      { href: "/parties/drivers", label: "Drivers", icon: UserRound, permission: "driver.read" },
      { href: "/parties/trucks", label: "Trucks", icon: Truck, permission: "truck.read" },
      { href: "/parties/trailers", label: "Trailers", icon: Package, permission: "trailer.read" },
      { href: "/parties/partners", label: "Partners", icon: Handshake, permission: "partner.read" },
    ],
  },
  {
    key: "insights",
    label: "Insights",
    icon: BarChart3,
    items: [
      { href: "/alerts", label: "Alerts", icon: AlertTriangle, permission: "alert.read" },
      { href: "/reports", label: "Reports", icon: BarChart3, permission: "report.read" },
    ],
  },
  {
    key: "reference",
    label: "Help & resources",
    icon: BookOpen,
    items: [
      { href: "/resources", label: "Resources", icon: BookOpen },
      { href: "/help", label: "Help centre", icon: HelpCircle },
      { href: "/legal/terms", label: "Legal", icon: Scale },
    ],
  },
];

const SETTINGS: NavItem[] = [
  {
    href: "/settings/organization",
    label: "Organization",
    icon: Building2,
    permission: "organization.read",
  },
  { href: "/settings/users", label: "Users", icon: Users, permission: "organization.members.read" },
  {
    href: "/settings/roles",
    label: "Roles",
    icon: ShieldCheck,
    permission: "organization.roles.manage",
  },
  { href: "/settings/audit", label: "Audit log", icon: ScrollText, permission: "audit_log.read" },
  { href: "/settings/billing", label: "Billing", icon: CreditCard, permission: "billing.read" },
  {
    href: "/settings/integrations",
    label: "Integrations",
    icon: Plug,
    permission: "integrations.manage",
  },
  { href: "/settings/notifications", label: "Notifications", icon: Bell },
  { href: "/settings/profile", label: "My profile", icon: CircleUser },
];

interface ContextLink {
  href: string;
  label: string;
  permission?: PermissionKey;
}

interface PageContext {
  section: string;
  title: string;
  links: ContextLink[];
}

function pageContext(pathname: string): PageContext {
  if (pathname === "/dashboard") {
    return {
      section: "Workspace",
      title: "Dashboard",
      links: [
        { href: "/movements/new", label: "New movement", permission: "movement.write" },
        { href: "/settings/users", label: "Users", permission: "organization.members.read" },
        { href: "/settings/roles", label: "Roles", permission: "organization.roles.manage" },
      ],
    };
  }
  if (pathname === "/movements/new") {
    return {
      section: "Operations",
      title: "New movement",
      links: [
        { href: "/movements", label: "All movements", permission: "movement.read" },
        { href: "/shipments", label: "Shipments", permission: "shipment.read" },
      ],
    };
  }
  const movement = pathname.match(/^\/movements\/([^/]+)$/);
  if (movement) {
    return {
      section: "Operations",
      title: "Movement workspace",
      links: [
        { href: "/movements", label: "All movements", permission: "movement.read" },
        {
          href: `/documents?movement=${movement[1]}`,
          label: "Documents",
          permission: "document.read",
        },
      ],
    };
  }
  if (pathname.startsWith("/movements")) {
    return {
      section: "Operations",
      title: "Movements",
      links: [
        { href: "/shipments", label: "Shipments", permission: "shipment.read" },
        { href: "/documents", label: "Documents", permission: "document.read" },
      ],
    };
  }
  if (pathname === "/shipments/import") {
    return {
      section: "Operations",
      title: "Import shipments",
      links: [
        { href: "/shipments", label: "All shipments", permission: "shipment.read" },
        { href: "/movements", label: "Movements", permission: "movement.read" },
      ],
    };
  }
  if (/^\/shipments\/[^/]+$/.test(pathname)) {
    return {
      section: "Operations",
      title: "Shipment details",
      links: [
        { href: "/shipments", label: "All shipments", permission: "shipment.read" },
        { href: "/movements", label: "Movements", permission: "movement.read" },
      ],
    };
  }
  if (pathname.startsWith("/shipments")) {
    return {
      section: "Operations",
      title: "Shipments",
      links: [
        { href: "/shipments/import", label: "Import CSV", permission: "import.run" },
        { href: "/movements", label: "Movements", permission: "movement.read" },
      ],
    };
  }
  if (/^\/documents\/[^/]+$/.test(pathname)) {
    return {
      section: "Operations",
      title: "Review document",
      links: [
        { href: "/documents", label: "All documents", permission: "document.read" },
        { href: "/movements", label: "Movements", permission: "movement.read" },
      ],
    };
  }
  if (pathname.startsWith("/documents")) {
    return {
      section: "Operations",
      title: "Documents",
      links: [
        { href: "/movements", label: "Movements", permission: "movement.read" },
        { href: "/shipments", label: "Shipments", permission: "shipment.read" },
      ],
    };
  }
  if (pathname.startsWith("/in-bond")) {
    return {
      section: "Operations",
      title: "In-bond",
      links: [
        { href: "/shipments", label: "Shipments", permission: "shipment.read" },
        { href: "/pars-rns", label: "PARS RNS", permission: "shipment.read" },
      ],
    };
  }
  if (pathname.startsWith("/pars-rns")) {
    return {
      section: "Operations",
      title: "PARS RNS",
      links: [
        { href: "/shipments", label: "Shipments", permission: "shipment.read" },
        { href: "/in-bond", label: "In-bond", permission: "inbond.read" },
      ],
    };
  }
  if (pathname.startsWith("/parties/")) {
    const title =
      pathname.split("/")[2]?.replace(/^./, (value) => value.toUpperCase()) ?? "Directory";
    return {
      section: "Directory",
      title,
      links: [
        { href: "/movements", label: "Movements", permission: "movement.read" },
        { href: "/alerts", label: "Alerts", permission: "alert.read" },
      ],
    };
  }
  if (pathname.startsWith("/alerts")) {
    return {
      section: "Insights",
      title: "Compliance alerts",
      links: [
        { href: "/movements", label: "Movements", permission: "movement.read" },
        { href: "/reports", label: "Reports", permission: "report.read" },
      ],
    };
  }
  if (pathname.startsWith("/reports")) {
    return {
      section: "Insights",
      title: "Reports",
      links: [
        { href: "/movements", label: "Movements", permission: "movement.read" },
        { href: "/shipments", label: "Shipments", permission: "shipment.read" },
      ],
    };
  }
  if (pathname.startsWith("/copilot")) {
    return {
      section: "Workspace",
      title: "Compliance copilot",
      links: [
        { href: "/documents", label: "Documents", permission: "document.read" },
        { href: "/help", label: "Help centre" },
      ],
    };
  }
  if (pathname === "/notifications") {
    return {
      section: "Workspace",
      title: "Notifications",
      links: [
        { href: "/alerts", label: "Alerts", permission: "alert.read" },
        { href: "/dashboard", label: "Dashboard" },
      ],
    };
  }
  if (pathname.startsWith("/settings/")) {
    const key = pathname.split("/")[2] ?? "organization";
    const item = SETTINGS.find((candidate) => candidate.href.endsWith(`/${key}`));
    return {
      section: "Settings",
      title: item?.label ?? "Settings",
      links: (
        [
          {
            href: "/settings/organization",
            label: "Organization",
            permission: "organization.read",
          },
          { href: "/settings/users", label: "Users", permission: "organization.members.read" },
          {
            href: "/settings/integrations",
            label: "Integrations",
            permission: "integrations.manage",
          },
        ] satisfies ContextLink[]
      ).filter((link) => link.href !== pathname),
    };
  }
  if (pathname.startsWith("/help")) {
    return {
      section: "Reference",
      title: "Help centre",
      links: [
        { href: "/resources", label: "Resources" },
        { href: "/dashboard", label: "Dashboard" },
      ],
    };
  }
  return {
    section: "Reference",
    title: "Resources",
    links: [
      { href: "/help", label: "Help centre" },
      { href: "/movements", label: "Movements", permission: "movement.read" },
    ],
  };
}

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
  const can = (permission?: PermissionKey) => !permission || permissions.includes(permission);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const previousPath = useRef(pathname);
  const context = pageContext(pathname);

  useEffect(() => {
    if (previousPath.current !== pathname) {
      mainRef.current?.focus({ preventScroll: true });
      previousPath.current = pathname;
    }
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileOpen]);

  const visibleSections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(item.permission)),
  })).filter((section) => section.items.length > 0);
  const settingsVisible = SETTINGS.filter((item) => can(item.permission));
  const settingsActive = settingsVisible.some((item) => isActive(pathname, item.href));
  const contextLinks = context.links.filter((link) => can(link.permission));

  /** Groups default open only when they contain the current route. */
  const isGroupOpen = (key: string, active: boolean) => openGroups[key] ?? active;
  const setGroupOpen = (key: string) => (open: boolean) =>
    setOpenGroups((previous) => ({ ...previous, [key]: open }));

  const renderItem = (item: NavItem) => {
    const active = isActive(pathname, item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={navItemVariants({ active })}
        onClick={() => setMobileOpen(false)}
      >
        <NavItemContent icon={item.icon}>{item.label}</NavItemContent>
      </Link>
    );
  };

  return (
    <div className="flex min-h-dvh bg-surface-canvas">
      <a
        href="#main-content"
        className="fixed left-4 top-3 z-[70] -translate-y-20 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg shadow-md transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>

      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-40 cursor-default bg-ink-950/50 backdrop-blur-[2px] lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        id="app-navigation"
        className={`app-navigation fixed inset-y-0 left-0 z-50 flex w-72 max-w-[calc(100vw-1rem)] shrink-0 flex-col border-r border-border-default bg-surface-raised shadow-lg transition-transform lg:sticky lg:top-0 lg:z-30 lg:h-dvh lg:w-60 lg:max-w-none lg:translate-x-0 lg:shadow-none ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="app-navigation-header flex min-h-16 shrink-0 items-center gap-3 border-b border-border-default px-4">
          <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm">
            <Route className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold tracking-tight text-fg-primary">Corridor</div>
            <div className="truncate text-xs text-fg-secondary">{organizationName}</div>
          </div>
          <button
            type="button"
            aria-label="Close menu"
            className="inline-flex size-10 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary lg:hidden"
            onClick={() => setMobileOpen(false)}
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="Primary">
          {renderItem(DASHBOARD)}
          {can(COPILOT.permission) && renderItem(COPILOT)}
          <div className="my-3 border-t border-border-default" />
          {visibleSections.map((section) => {
            const active = section.items.some((item) => isActive(pathname, item.href));
            return (
              <NavGroup
                key={section.key}
                icon={section.icon}
                label={section.label}
                active={active}
                open={isGroupOpen(section.key, active)}
                onOpenChange={setGroupOpen(section.key)}
              >
                {section.items.map(renderItem)}
              </NavGroup>
            );
          })}
        </nav>

        <div className="app-navigation-footer max-h-[55dvh] shrink-0 overflow-y-auto border-t border-border-default p-3">
          {settingsVisible.length > 0 && (
            <NavGroup
              icon={SettingsIcon}
              label="Settings"
              active={settingsActive}
              open={isGroupOpen("settings", settingsActive)}
              onOpenChange={setGroupOpen("settings")}
              className="mb-2"
            >
              {settingsVisible.map(renderItem)}
            </NavGroup>
          )}
          <div className="flex items-center gap-3 rounded-lg bg-surface-sunken/70 p-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
              {(user.displayName ?? user.email ?? "U").slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-fg-primary">
                {user.displayName ?? user.email}
              </div>
              <div className="truncate text-xs text-fg-secondary">{roleName}</div>
            </div>
            <ThemeToggle />
          </div>
          <form action="/auth/signout" method="post" className="mt-1 px-2">
            <button
              type="submit"
              className="min-h-8 text-xs font-medium text-fg-secondary hover:text-fg-primary"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="app-header sticky top-0 z-30 flex min-h-16 flex-wrap items-center gap-3 border-b border-border-default bg-surface-raised/95 px-4 py-2 backdrop-blur sm:px-6 md:flex-nowrap md:py-0">
          <button
            type="button"
            aria-label="Open menu"
            aria-controls="app-navigation"
            aria-expanded={mobileOpen}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-5" aria-hidden />
          </button>

          <div className="min-w-0 flex-1">
            <div className="hidden items-center gap-2 text-xs text-fg-secondary sm:flex">
              <span>{context.section}</span>
              <span aria-hidden>/</span>
              <span className="font-medium text-fg-primary">{context.title}</span>
            </div>
            <div className="truncate text-sm font-semibold text-fg-primary sm:hidden">
              {context.title}
            </div>
          </div>

          {contextLinks.length > 0 && (
            <nav
              aria-label="Next steps"
              className="order-last flex w-full flex-wrap items-center gap-2 border-t border-border-default pt-2 md:order-none md:w-auto md:flex-nowrap md:gap-1 md:border-r md:border-t-0 md:py-0 md:pr-3"
            >
              <span className="mr-1 hidden text-[11px] font-semibold uppercase tracking-wider text-fg-secondary sm:inline">
                Next
              </span>
              {contextLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="inline-flex min-h-11 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40 md:min-h-9"
                >
                  {link.label}
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </Link>
              ))}
            </nav>
          )}
          <NotificationBell />
        </header>

        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="app-content mx-auto w-full max-w-[100rem] p-4 outline-none sm:p-6 xl:p-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
