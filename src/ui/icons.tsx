import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...p,
});

export const IconCamera = (p: P) => (
  <svg {...base(p)}>
    <path d="M3.5 8.5A2 2 0 0 1 5.5 6.5h2l1.4-2h6.2l1.4 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.6" />
  </svg>
);

export const IconCameraOff = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 3l18 18" />
    <path d="M9 4.5h6.1l1.4 2h2a2 2 0 0 1 2 2v8.5M18 19.5H5.5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1" />
    <path d="M9.7 10.7a3.6 3.6 0 0 0 4.9 4.9" />
  </svg>
);

export const IconPause = (p: P) => (
  <svg {...base(p)}>
    <path d="M8.5 5.5v13M15.5 5.5v13" />
  </svg>
);

export const IconPlay = (p: P) => (
  <svg {...base(p)}>
    <path d="M7.5 5.2v13.6L18.5 12z" />
  </svg>
);

export const IconLock = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </svg>
);

export const IconUnlock = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.6-1.6" />
  </svg>
);

export const IconReset = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
    <path d="M4.5 4.5v3.7h3.7" />
  </svg>
);

/** Four corners closing on a centre: calibration. */
export const IconCalibrate = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <circle cx="12" cy="12" r="2.2" />
  </svg>
);

export const IconSkeleton = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 20.5v-6M12 14.5l-4.5-8M12 14.5L12 4.5M12 14.5l4.5-7.5M12 14.5l6-3" />
    <circle cx="12" cy="20.5" r="1" />
    <circle cx="7.5" cy="6.5" r="1" />
    <circle cx="12" cy="4.5" r="1" />
    <circle cx="16.5" cy="7" r="1" />
    <circle cx="18" cy="11.5" r="1" />
  </svg>
);

export const IconSnapshot = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5l3.2 5.6M20.3 10.2l-6.4.2M17 18.8l-3.2-5.6M6.9 18.6l3.3-5.5M3.7 13.6l6.4-.1M7.2 5.3l3.1 5.6" />
  </svg>
);

export const IconRecord = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none" />
  </svg>
);

export const IconFullscreen = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
  </svg>
);

export const IconTune = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </svg>
);

export const IconClose = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** The portal mark: a skewed quad with lit corners. */
export const IconPortal = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 6.5l14-2.5-1.2 15.5-11-2.2z" />
    <circle cx="4.5" cy="6.5" r="1.3" fill="currentColor" />
    <circle cx="18.5" cy="4" r="1.3" fill="currentColor" />
    <circle cx="17.3" cy="19.5" r="1.3" fill="currentColor" />
    <circle cx="6.3" cy="17.3" r="1.3" fill="currentColor" />
  </svg>
);

export const IconHands = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 20v-4.5L4.5 11M7 15.5L6 6M7 15.5l3-9M17 20v-4.5l2.5-4.5M17 15.5L18 6M17 15.5l-3-9" />
  </svg>
);
