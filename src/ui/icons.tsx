// Line icons for the build bar, building cards and info views. Drawn on a 24-unit grid with the current text colour.

import type { JSX } from 'preact';

const ICONS = {
  cursor: () => <path d="M6 3l12 8-5.5 1.5L10 18z" />,
  road: () => <path d="M8 3L5 21M16 3l3 18M12 4v3M12 10.5v3M12 17v3" />,
  avenue: () => <path d="M6 3L3 21M18 3l3 18M10 4v2.5M10 10v2.5M10 16v2.5M14 4v2.5M14 10v2.5M14 16v2.5" />,
  widen: () => <path d="M9 3L6 21M15 3l3 18M12 9l-2.5 3 2.5 3M12 9l2.5 3-2.5 3" />,
  canal: () => <path d="M3 8c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0M3 13c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0M3 18c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0" />,
  zone: () => <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>,
  residential: () => <path d="M3.5 11L12 4l8.5 7M6 9.5V20h12V9.5M10 20v-5h4v5" />,
  commercial: () => <path d="M5 9h14l-1.2 11H6.2zM9 9V7.5a3 3 0 0 1 6 0V9" />,
  industrial: () => <path d="M3 20v-9l5 3v-3l5 3v-3l4 2.5V5h3v15z" />,
  agricultural: () => <path d="M12 21V9M12 9c-2.2-.7-3.5-2.6-3.5-5 2.2.7 3.5 2.6 3.5 5zM12 9c2.2-.7 3.5-2.6 3.5-5-2.2.7-3.5 2.6-3.5 5zM12 14.5c-2.2-.7-3.5-2.6-3.5-5 2.2.7 3.5 2.6 3.5 5zM12 14.5c2.2-.7 3.5-2.6 3.5-5-2.2.7-3.5 2.6-3.5 5z" />,
  power: () => <path d="M13 2.5L5.5 13.5H11l-1 8 7.5-11H12z" />,
  water: () => <path d="M12 3.5c3 4.3 6 7.5 6 10.8a6 6 0 0 1-12 0c0-3.3 3-6.5 6-10.8z" />,
  services: () => <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v8M8 12h8" /></>,
  park: () => <><path d="M12 3l5.5 8H14l4 6H6l4-6H6.5z" /><path d="M12 17v4" /></>,
  plane: () => <path d="M2.5 12.5L21 5l-4.5 15-4-6-5 2 1-4z" />,
  bulldoze: () => <><path d="M3 15.5h10.5V10H9L7.5 7H4.5v8.5" /><path d="M13.5 12.5h3l3.5 5h-6" /><circle cx="6" cy="18.5" r="1.6" /><circle cx="11" cy="18.5" r="1.6" /></>,
  layers: () => <><path d="M12 3.5l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  camera: () => <><rect x="3" y="7" width="18" height="13" rx="2" /><circle cx="12" cy="13.5" r="3.5" /><path d="M8.5 7l1.5-2.5h4L15.5 7" /></>,
  eye: () => <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  coin: () => <><circle cx="12" cy="12" r="8.5" /><path d="M14.8 9.3c-.4-1-1.5-1.6-2.8-1.6-1.6 0-2.8.8-2.8 2.1 0 2.8 5.8 1.4 5.8 4.3 0 1.3-1.3 2.2-3 2.2-1.4 0-2.6-.7-3-1.8M12 6v1.7M12 16.3V18" /></>,
  cloud: () => <path d="M7.5 18a4 4 0 0 1-.4-8 5.2 5.2 0 0 1 10-.8A4.4 4.4 0 0 1 17 18z" />,
  car: () => <><path d="M4.5 15.5v-3.5l2-5h11l2 5v3.5z" /><path d="M4.5 12h15" /><circle cx="8" cy="17" r="1.6" /><circle cx="16" cy="17" r="1.6" /></>,
  cone: () => <path d="M10 4h4l4 15H6zM8 12h8M5 20h14" />,
  fire: () => <path d="M12 3c.8 3.6 5 5.4 5 10.2a5 5 0 0 1-10 0c0-2.1 1-3.6 2.1-4.6.2 1.8 1 2.8 2 3.1-.8-3.1.1-6 .9-8.7z" />,
  smile: () => <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14c1.6 2 5.4 2 7 0M9 9.5h.01M15 9.5h.01" /></>,
  clinic: () => <path d="M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z" />,
  hospital: () => <><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><path d="M8.5 7.5v9M15.5 7.5v9M8.5 12h7" /></>,
  school: () => <path d="M3 5.5h6.5A2.5 2.5 0 0 1 12 8v12a2 2 0 0 0-2-2H3zM21 5.5h-6.5A2.5 2.5 0 0 0 12 8v12a2 2 0 0 1 2-2h7z" />,
  college: () => <><path d="M2 9.5L12 4.5l10 5-10 5z" /><path d="M6 11.5v4.5c3.3 2.2 8.7 2.2 12 0v-4.5M22 9.5v5" /></>,
  police: () => <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6z" />,
  townhall: () => <path d="M3 9.5L12 4l9 5.5zM5.5 10.5v8M10 10.5v8M14 10.5v8M18.5 10.5v8M3 20.5h18" />,
  housing: () => <><rect x="5" y="3.5" width="14" height="17" rx="1" /><path d="M8.5 7.5h2M13.5 7.5h2M8.5 11h2M13.5 11h2M8.5 14.5h2M13.5 14.5h2M10.5 20.5v-3h3v3" /></>,
  museum: () => <path d="M3 9L12 4l9 5H3zM5 11h14M6.5 11v7M10 11v7M14 11v7M17.5 11v7M4 20.5h16" />,
  stadium: () => <><ellipse cx="12" cy="12" rx="9" ry="6" /><ellipse cx="12" cy="12" rx="4.5" ry="2.6" /><path d="M12 9.4v5.2" /></>,
  pylon: () => <path d="M8.5 21L12 3l3.5 18M6 8h12M7 13h10M9.2 21l5.4-8M14.8 21l-5.4-8" />,
  gas: () => <><path d="M3 20.5V12l5 3v-3l5 3V8h5v12.5z" /><path d="M15.5 8V4.5M15.5 4.5c1 0 1.5-.8 1.5-1.5" /></>,
  sun: () => <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8" /></>,
  turbine: () => <><path d="M12 11v10M9.5 21h5M12 11V3.5M12 11l6.5 3.8M12 11l-6.5 3.8" /><circle cx="12" cy="11" r="1.3" /></>,
} satisfies Record<string, () => JSX.Element>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]()}
    </svg>
  );
}
