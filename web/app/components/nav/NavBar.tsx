import { NavLink } from "react-router";

const NAV_ITEMS = [
  { to: "/ps",       label: "Professional Services" },
  { to: "/radix-rd", label: "Radix R&D"             },
  { to: "/enc-rd",   label: "enCompass R&D"         },
  { to: "/interco-rd", label: "Interco R&D Invoice"  },
  { to: "/upload",   label: "Data Import"           },
  { to: "/roster",   label: "Roster"                },
];

export default function NavBar() {
  return (
    <nav className="flex items-center bg-dash-nav-bg border border-dash-border rounded-lg px-3.5 py-2 mb-3 h-12 gap-1.5">
      <a
        href="/"
        className="flex items-center text-dash-accent hover:text-dash-accent-hover transition-colors"
        aria-label="Home"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
          <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
        </svg>
      </a>
      <div className="w-px h-5 bg-dash-border mx-2" />
      <span className="font-heading text-[13px] font-bold text-dash-text-secondary mr-2.5">
        LABOR ANALYSIS
      </span>
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            `font-ui text-xs font-medium tracking-wide uppercase no-underline px-3.5 py-1.5 rounded-md border transition-all duration-150 ${
              isActive
                ? "bg-dash-surface text-dash-accent border-dash-accent-muted"
                : "text-dash-text-muted border-transparent hover:bg-dash-surface-raised hover:text-dash-text hover:border-dash-border"
            }`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
