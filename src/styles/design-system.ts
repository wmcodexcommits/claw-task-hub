export const layoutPrimitives = [
  "Row",
  "Stack",
  "Grid",
  "Split",
  "Scroll",
  "Overlay",
  "Center",
  "AbsoluteList",
  "Truncate",
] as const;

export const controlAlgebra = {
  shape: ["rectangle", "pill", "circle"],
  size: ["compact", "normal", "large"],
  tone: ["normal", "muted", "primary", "success", "warning", "danger"],
  state: ["idle", "hover", "focus", "active", "disabled", "busy"],
} as const;

export const statusTones = {
  started: "warning",
  completed: "success",
  blocked: "danger",
  canceled: "muted",
  p1: "danger",
  p2: "warning",
} as const;

const shellTop = 56;
const shellBottom = 28;

export const design = {
  fontFamily: 'Inter, ui-sans-serif, system-ui, "Segoe UI", Roboto, Arial, sans-serif',
  space: [4, 8, 12, 16, 24],
  dimensions: {
    control: 32,
    pill: 28,
    shellTop,
    shellBottom,
    issueGroup: 36,
    issueRow: 44,
    issueOverscan: 440,
  },
  radius: 7,
  typography: {
    navTitleSize: 32,
    navTitleWeight: 800,
  },
  breakpoints: {
    filters: 1100,
    compact: 920,
    mobile: 640,
  },
  layouts: {
    shellRows: `${shellTop}px minmax(0, 1fr) ${shellBottom}px`,
    issueSplit: "minmax(520px, 1fr) minmax(320px, 0.72fr)",
    projectColumns: "minmax(270px, 1fr) 118px 100px 140px 130px 70px 130px",
    projectColumnsCompact: "minmax(220px, 1fr) 110px 90px 120px 54px",
    projectColumnsMobile: "minmax(0, 1fr) 46px",
    issueColumns: "74px 22px minmax(220px, 1fr) minmax(120px, 190px) 58px",
    issueColumnsMobile: "62px 20px minmax(0, 1fr) 52px",
  },
  placement: {
    viewportGap: 4,
    dropdownMinimumSpace: 120,
    dropdownMinimumHeight: 88,
    dropdownMaximumHeight: 280,
  },
  themes: {
    dark: {
      bg: "#080808", surface: "#101010", surfaceRaised: "#151515", surfaceHover: "#1c1c1c", surfaceActive: "#242424",
      borderSubtle: "#242424", border: "#2d2d2d", text: "#eeeeee", navTitle: "#ffffff", muted: "#9a9a9a", dim: "#686868",
      yellow: "#ffd400", blue: "#5b8cff", green: "#35b86b", red: "#ff6565", primary: "#315fb4", onPrimary: "#ffffff",
      accentSoft: "#1b2230", successSoft: "#17331f", dangerSoft: "#251212", dangerBorder: "#703333",
      menuShadow: "0 14px 36px rgb(0 0 0 / 0.5)", overlay: "rgb(0 0 0 / 0.58)", dialogShadow: "0 24px 80px rgb(0 0 0 / 0.45)",
    },
    light: {
      bg: "#f5f6f8", surface: "#ffffff", surfaceRaised: "#f0f2f5", surfaceHover: "#e7eaf0", surfaceActive: "#dfe4ea",
      borderSubtle: "#e0e4e9", border: "#c7ccd4", text: "#17191d", navTitle: "#000000", muted: "#606772", dim: "#858c96",
      yellow: "#9b6d00", blue: "#315fb4", green: "#168a48", red: "#c43e3e", primary: "#315fb4", onPrimary: "#ffffff",
      accentSoft: "#e6edf9", successSoft: "#e5f4eb", dangerSoft: "#faeaea", dangerBorder: "#dfaaaa",
      menuShadow: "0 14px 36px rgb(32 38 48 / 0.2)", overlay: "rgb(28 32 38 / 0.3)", dialogShadow: "0 24px 80px rgb(32 38 48 / 0.22)",
    },
  },
} as const;

export type DesignSystem = typeof design;
